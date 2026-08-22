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

  it('returns undefined for an unknown id and rejects a wait on one', async () => {
    const q = new JobQueue<string, string>({ concurrency: 1, idgen: ids(), now: () => 0, run: async () => 'ok' });
    expect(q.get('nope')).toBeUndefined();
    await expect(q.wait('nope')).rejects.toThrow(/unknown job/i);
  });
});
