import { describe, it, expect } from 'vitest';
import { JobQueue } from '../../src/jobs/queue.js';

/** A controllable worker: each call parks until the test resolves it. */
function gate() {
  const opened: Array<(v: string) => void> = [];
  const failed: Array<(e: unknown) => void> = [];
  const run = () =>
    new Promise<string>((resolve, reject) => {
      opened.push(resolve);
      failed.push(reject);
    });
  return { run, opened, failed };
}

/**
 * Yield until `cond` holds. The queue starts work one microtask after submit(), and these
 * tests need the worker's resolver before poking it. Looping rather than awaiting a fixed
 * number of ticks means an extra hop inside pump() degrades to a timeout with a readable
 * message instead of a TypeError on an undefined resolver.
 */
async function until(cond: () => boolean, ticks = 100): Promise<void> {
  for (let i = 0; i < ticks && !cond(); i++) await Promise.resolve();
  if (!cond()) throw new Error('condition never became true within ' + ticks + ' microtasks');
}

const ids = () => {
  let n = 0;
  return () => `job-${++n}`;
};

describe('JobQueue', () => {
  it('runs a submitted job and records the result', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 1000,
      run: async (payload) => `ran:${payload}`,
    });

    const job = q.submit('k1', 'alpha');
    expect(job.id).toBe('job-1');
    // submit() claims the slot synchronously when one is free, so 'running' is the honest
    // reading. (The work itself starts one microtask later — see pump().)
    expect(job.state).toBe('running');

    const done = await q.wait(job.id);
    expect(done.state).toBe('done');
    expect(done.result).toBe('ran:alpha');
    expect(done.createdAt).toBe(1000);
  });

  it('queues jobs when concurrency is full', async () => {
    const g = gate();
    const q = new JobQueue<string, string>({ concurrency: 1, idgen: ids(), now: () => 0, run: g.run });

    const job1 = q.submit('a', 'a');
    expect(job1.state).toBe('running');

    const job2 = q.submit('b', 'b');
    expect(job2.state).toBe('queued');

    await until(() => g.opened.length > 0); // let run() be invoked (it starts a microtask after submit)

    g.opened[0]!('done');
    await new Promise((r) => setTimeout(r, 0)); // Wait for pump() to start job2

    expect(job2.state).toBe('running');
    g.opened[1]!('done');
    await q.wait(job2.id);
  });

  it('records a failure code when the worker throws', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: async () => { throw Object.assign(new Error('nope'), { code: 'blocked' }); },
    });

    const done = await q.wait(q.submit('k', 'x').id);
    expect(done.state).toBe('failed');
    expect(done.error).toEqual({ code: 'blocked', message: 'nope' });
  });

  it('defaults an uncoded throw to network', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: async () => { throw new Error('socket died'); },
    });

    const done = await q.wait(q.submit('k', 'x').id);
    expect(done.error?.code).toBe('network');
    expect(done.error?.message).toBe('socket died');
  });

  it('handles a synchronously-throwing run function', async () => {
    let callCount = 0;
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: () => {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error('sync boom'), { code: 'blocked' });
        }
        return Promise.resolve('ok');
      },
    });

    const job1 = q.submit('k1', 'x');
    const done1 = await q.wait(job1.id);
    expect(done1.state).toBe('failed');
    expect(done1.error?.message).toBe('sync boom');
    expect(done1.error?.code).toBe('blocked');
    expect(q.busy).toBe(0);

    // Verify subsequent jobs still run
    const job2 = q.submit('k2', 'y');
    expect(q.busy).toBe(1);
    const done2 = await q.wait(job2.id);
    expect(done2.state).toBe('done');
    expect(q.busy).toBe(0);
  });

  it('dedupes an identical key that is still in flight', async () => {
    const g = gate();
    const q = new JobQueue<string, string>({ concurrency: 4, idgen: ids(), now: () => 0, run: g.run });

    const a = q.submit('same', 'x');
    const b = q.submit('same', 'x');
    expect(b.id).toBe(a.id);
    expect(q.depth).toBe(1);

    await until(() => g.opened.length > 0); // let run() be invoked (it starts a microtask after submit)

    g.opened[0]!('done');
    await q.wait(a.id);
  });

  it('does not dedupe against a job that already settled', async () => {
    const q = new JobQueue<string, string>({ concurrency: 1, idgen: ids(), now: () => 0, run: async () => 'ok' });

    const a = q.submit('same', 'x');
    await q.wait(a.id);
    const b = q.submit('same', 'x');

    expect(b.id).not.toBe(a.id);
  });

  it('never runs more than `concurrency` jobs at once', async () => {
    const g = gate();
    const q = new JobQueue<string, string>({ concurrency: 2, idgen: ids(), now: () => 0, run: g.run });

    q.submit('a', 'a'); q.submit('b', 'b'); q.submit('c', 'c');
    await Promise.resolve();

    expect(g.opened.length).toBe(2);
    expect(q.busy).toBe(2);

    g.opened[0]!('first');
    await new Promise((r) => setTimeout(r, 0));
    expect(g.opened.length).toBe(3);
    expect(q.busy).toBe(2);
  });

  // A settled job holds a whole Solution — page HTML included — and this process runs for
  // weeks. Retaining them is a gigabyte-scale leak, so the record goes once it is answered.
  it('retains no record for a job that has settled and been waited on', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: async () => 'a'.repeat(1024),
    });

    for (let i = 0; i < 5; i++) {
      const job = q.submit(`key-${i}`, 'x');
      expect(q.size).toBe(1);
      const done = await q.wait(job.id);
      // The waiter still has its answer; only the queue's own bookkeeping went.
      expect(done.result).toBe('a'.repeat(1024));
      expect(q.size).toBe(0);
    }

    expect(q.size).toBe(0);
    expect(q.depth).toBe(0);
    expect(q.busy).toBe(0);
  });

  // The dedupe index is a second map keyed by the caller's key. Pruning `jobs` alone would
  // just move the leak into it.
  it('drops the dedupe index entry along with the settled job', async () => {
    const q = new JobQueue<string, string>({ concurrency: 1, idgen: ids(), now: () => 0, run: async () => 'ok' });

    await q.wait(q.submit('same', 'x').id);
    expect(q.size).toBe(0);

    // A repeat of the same key must still start fresh work rather than resolving from a
    // record that is no longer there.
    const b = q.submit('same', 'x');
    expect(b.id).toBe('job-2');
    expect(q.depth).toBe(1);
    const done = await q.wait(b.id);
    expect(done.state).toBe('done');
    expect(q.size).toBe(0);
  });

  // A failed job leaks exactly as readily as a done one.
  it('retains no record for a job that failed', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: async () => { throw new Error('nope'); },
    });

    const done = await q.wait(q.submit('k', 'x').id);
    expect(done.state).toBe('failed');
    expect(q.size).toBe(0);
  });

  // Chromium rejects loadURL with its own vocabulary (ERR_CONNECTION_REFUSED and friends).
  // Casting those into a field typed FailureCode is a type lie; they are network faults.
  it('rejects a foreign code and files it as network, keeping the message', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: async () => {
        throw Object.assign(new Error('ERR_CONNECTION_REFUSED (-102) loading http://x/'), {
          code: 'ERR_CONNECTION_REFUSED',
        });
      },
    });

    const done = await q.wait(q.submit('k', 'x').id);
    expect(done.error?.code).toBe('network');
    expect(done.error?.message).toBe('ERR_CONNECTION_REFUSED (-102) loading http://x/');
  });

  it('keeps every code that really is a FailureCode', async () => {
    const codes = [
      'challenge-failed', 'pending-timeout', 'blocked', 'http-error',
      'network', 'cancelled', 'browser-crashed', 'disk-full',
    ];

    for (const code of codes) {
      const q = new JobQueue<string, string>({
        concurrency: 1,
        idgen: ids(),
        now: () => 0,
        run: async () => { throw Object.assign(new Error('x'), { code }); },
      });
      const done = await q.wait(q.submit('k', 'x').id);
      expect(done.error?.code).toBe(code);
    }
  });

  it('returns undefined for an unknown id and rejects a wait on one', async () => {
    const q = new JobQueue<string, string>({ concurrency: 1, idgen: ids(), now: () => 0, run: async () => 'ok' });
    expect(q.get('nope')).toBeUndefined();
    await expect(q.wait('nope')).rejects.toThrow(/unknown job/i);
  });
});
