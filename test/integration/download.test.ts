import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startGatehouse, type Harness } from './harness.js';
import { startFileHost, type FileHost } from '../fixture/filehost.js';

/**
 * The whole download path through the REAL built app: `/gh/fetch` accepted by the shipped
 * server, the bytes pulled by Electron's `net` on a persistent partition, written by
 * `transfer`, recorded by `DownloadStore`, and served back by the Range file server.
 *
 * Nothing here is stubbed. The one thing it deliberately does not prove is the premise — the
 * file host is a local fixture, not a Cloudflare-protected origin, so this shows the mechanism
 * works and says nothing about whether a real host would hand these bytes over.
 */

let gh: Harness;
let host: FileHost;
let dir: string;

// Big enough that the body genuinely streams in many chunks rather than arriving in one.
const BODY = Buffer.alloc(3 * 1024 * 1024, 42);
const SHA = createHash('sha256').update(BODY).digest('hex');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-dl-'));
  gh = await startGatehouse({ GATEHOUSE_DOWNLOADS_DIR: dir });
  host = await startFileHost({ body: BODY, filename: 'payload.bin' });
}, 60_000);

afterAll(async () => {
  await gh?.stop();
  await host?.close();
  await rm(dir, { recursive: true, force: true });
});

interface JobBody {
  state: string;
  progress: { received: number; total: number };
  result?: { path: string; url: string; size: number; sha256: string; filename: string; contentType: string };
  error?: { code: string; message: string };
}

const job = async (id: string): Promise<JobBody> =>
  (await (await fetch(`${gh.url}/gh/jobs/${id}`)).json()) as JobBody;

/** Poll until the job reaches `want`, or settles as something else, or the deadline passes. */
const poll = async (id: string, want: string, ms = 30_000): Promise<JobBody> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = await job(id);
    if (body.state === want) return body;
    // Returning on ANY settled state rather than looping: a job that failed will never become
    // `done`, and the assertion that follows should report the failure, not a timeout.
    if (['done', 'failed', 'cancelled'].includes(body.state)) return body;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${body.state}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe('downloading through the real app', () => {
  let id: string;

  it('accepts a fetch and completes it', async () => {
    const res = await fetch(`${gh.url}/gh/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: host.url, site: 'filehost' }),
    });
    expect(res.status).toBe(202);
    const accepted = (await res.json()) as { jobId: string; state: string };
    id = accepted.jobId;
    expect(accepted.state).toBe('queued');

    const done = await poll(id, 'done');
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('done');
    expect(done.result!.size).toBe(BODY.length);
    // The hash is the real proof: the bytes on disk are the bytes the host served, in order.
    expect(done.result!.sha256).toBe(SHA);
    expect(done.result!.filename).toBe('payload.bin');
    expect(done.result!.url).toBe(`/gh/files/${id}`);

    // A local path a consumer can hand to a mover, at the right size — the zero-copy case.
    expect((await stat(done.result!.path)).size).toBe(BODY.length);
    expect(done.result!.path.startsWith(dir)).toBe(true);
  }, 60_000);

  // NOT a dedupe test, whatever it was once called: the first job has already settled, so the
  // assertion below is that dedupe deliberately does NOT apply. The window is "unsettled
  // records only", or a completed download would pin a caller to bytes it may already have
  // released. The real in-flight dedupe is the test after this one.
  it('starts a fresh job when the previous download of the same target has settled', async () => {
    const res = await fetch(`${gh.url}/gh/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: host.url, site: 'filehost' }),
    });
    expect(res.status).toBe(202);
    const second = (await res.json()) as { jobId: string };
    expect(second.jobId).not.toBe(id);
    await poll(second.jobId, 'done');
    await fetch(`${gh.url}/gh/jobs/${second.jobId}`, { method: 'DELETE' });
  }, 60_000);

  it('dedupes a second fetch onto the job that is still in flight', async () => {
    // A host that never finishes is what holds the first job UNSETTLED long enough for the
    // second POST to land on it — the whole point of the dedupe window.
    const slowHost = await startFileHost({ mode: 'no-headers' });
    const body = JSON.stringify({ url: slowHost.url, site: 'dedupe' });
    const send = async (): Promise<string> => {
      const r = await fetch(`${gh.url}/gh/fetch`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      expect(r.status).toBe(202);
      return ((await r.json()) as { jobId: string }).jobId;
    };
    try {
      const first = await send();
      const second = await send();
      expect(second).toBe(first); // one record, one transfer, one set of bytes
    } finally {
      // Leave nothing running: this app's stall window is the 120s default, so only the
      // DELETE frees the slot before the suite ends.
      const dead = await fetch(`${gh.url}/gh/fetch`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      await fetch(`${gh.url}/gh/jobs/${((await dead.json()) as { jobId: string }).jobId}`, { method: 'DELETE' });
      await slowHost.close();
    }
  }, 60_000);

  it('serves the bytes back, with Range', async () => {
    const whole = await fetch(`${gh.url}/gh/files/${id}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await whole.arrayBuffer()).equals(BODY)).toBe(true);

    const part = await fetch(`${gh.url}/gh/files/${id}`, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${BODY.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(BODY.subarray(100, 200))).toBe(true);
  }, 60_000);

  it('releases the bytes on DELETE', async () => {
    const path = (await job(id)).result!.path;
    expect((await fetch(`${gh.url}/gh/jobs/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${gh.url}/gh/jobs/${id}`)).status).toBe(404);
    expect((await fetch(`${gh.url}/gh/files/${id}`)).status).toBe(404);
    await expect(stat(path)).rejects.toThrow();
  }, 60_000);

  it('cancels an in-flight download and leaves no partial', async () => {
    // 'stall' sends headers and one byte, then nothing forever — the transfer is parked in its
    // read loop, which is the state a cancel has to be able to interrupt.
    const stallHost = await startFileHost({ mode: 'stall' });
    try {
      const res = await fetch(`${gh.url}/gh/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: stallHost.url, site: 'stall' }),
      });
      expect(res.status).toBe(202);
      const stallId = ((await res.json()) as { jobId: string }).jobId;
      await new Promise((r) => setTimeout(r, 500));
      expect((await job(stallId)).state).toBe('running');

      expect((await fetch(`${gh.url}/gh/jobs/${stallId}`, { method: 'DELETE' })).status).toBe(204);
      const settled = await poll(stallId, 'cancelled', 15_000);
      expect(settled.state).toBe('cancelled');

      // What this asserts is NOT "the partial was cleaned up". Electron's `net` does not hand
      // a response to the transfer until it has buffered rather more than the one byte this
      // mode sends, so measured here the transfer is still parked in its REQUEST phase — no
      // response, no write stream, hence no `<id>.part` was ever created for the cleanup to
      // remove. The `total: -1` below is the proof of that, and it is why the assertion that
      // follows would pass with the partial-deletion deleted.
      //
      // So this covers the request-phase cancel through the shipped Electron requester, which
      // is worth having. The MID-BODY cancel — bytes on disk, stream open, partial unlinked
      // after the handle is released — is covered against `nodeRequester` in
      // test/unit/transfer.test.ts ("cancels and deletes the partial when the signal aborts"),
      // and cannot be reached from here without a host Electron will actually stream from.
      expect(settled.progress.total).toBe(-1);
      const left = (await readdir(dir)).filter((f) => f.startsWith(stallId));
      expect(left).toEqual([]);
    } finally {
      await stallHost.close();
    }
  }, 60_000);

  /**
   * Finding: a host that accepts the socket and never writes holds a concurrency slot with
   * nothing able to settle it but a caller DELETE. At the default of two slots, two such hosts
   * wedge the whole download surface while `/gh/fetch` keeps handing out 202s that never run.
   *
   * This runs a SECOND app of its own: one slot, so a wedged transfer starves everything, and
   * a 5s stall window (the configured minimum) so the test does not sit through the 120s
   * default. The assertion is not just "the stalled job settled" — it is that the job queued
   * BEHIND it then ran to completion, which is what "the slot was freed" actually means.
   */
  it('aborts a download that has gone idle, and frees the slot for the next one', async () => {
    const silentHost = await startFileHost({ mode: 'no-headers' });
    const goodHost = await startFileHost({ body: Buffer.alloc(64 * 1024, 3), filename: 'ok.bin' });
    const stallDir = await mkdtemp(join(tmpdir(), 'gh-stall-'));
    const app = await startGatehouse({
      GATEHOUSE_DOWNLOADS_DIR: stallDir,
      GATEHOUSE_DOWNLOAD_CONCURRENCY: '1',
      GATEHOUSE_DOWNLOAD_STALL_MS: '5000',
    });

    const fetchJob = async (url: string, site: string): Promise<string> => {
      const r = await fetch(`${app.url}/gh/fetch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, site }),
      });
      expect(r.status).toBe(202);
      return ((await r.json()) as { jobId: string }).jobId;
    };
    const state = async (id: string): Promise<JobBody> =>
      (await (await fetch(`${app.url}/gh/jobs/${id}`)).json()) as JobBody;
    // Bounded, and it RETURNS the unsettled record rather than throwing when the deadline
    // passes: with the watchdog removed this test must fail on an assertion naming the state
    // it was stuck in, not on a suite timeout.
    const settleWithin = async (id: string, ms: number): Promise<JobBody> => {
      const deadline = Date.now() + ms;
      for (;;) {
        const body = await state(id);
        if (['done', 'failed', 'cancelled'].includes(body.state)) return body;
        if (Date.now() > deadline) return body;
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    try {
      const silent = await fetchJob(silentHost.url, 'silenthost');
      const behind = await fetchJob(goodHost.url, 'goodhost');

      // The premise: the silent transfer holds the only slot and the next job cannot start.
      await new Promise((r) => setTimeout(r, 1_000));
      expect((await state(silent)).state).toBe('running');
      expect((await state(behind)).state).toBe('queued');

      // The watchdog aborts; `transfer`'s own cancel path is what settles the record, which is
      // why the message reads as a caller cancel — it is handed a signal, not a reason.
      const stalled = await settleWithin(silent, 20_000);
      expect(stalled.state).toBe('cancelled');
      expect(stalled.error!.code).toBe('cancelled');

      // The slot really was freed: the job behind it ran, and ran to completion.
      const next = await settleWithin(behind, 20_000);
      expect(next.state).toBe('done');
      expect(next.result!.size).toBe(64 * 1024);
    } finally {
      await app.stop();
      await silentHost.close();
      await goodHost.close();
      await rm(stallDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('reports downloads in health', async () => {
    const h = (await (await fetch(`${gh.url}/gh/health`)).json()) as {
      downloads?: { active: number; records: number };
    };
    expect(h.downloads).toBeDefined();
    expect(typeof h.downloads!.active).toBe('number');
    expect(typeof h.downloads!.records).toBe('number');
  });

  it('rejects a target the /v1 gate would also reject', async () => {
    const res = await fetch(`${gh.url}/gh/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    expect(res.status).toBe(400);
    // `/gh/*` has its own error shape; `/v1` keeps FlareSolverr's.
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-request');
  });
});
