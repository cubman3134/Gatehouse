import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGatehouse, type Harness } from './harness.js';
import { startFileHost, type FileHost } from '../fixture/filehost.js';

/**
 * The `/gh/*` SURFACE through the real built app: what a POST is folded onto, what frees a
 * wedged slot, and what the health route says. The engine underneath it — Chromium's own
 * download stack, hashing, the `.part` rename, Range serving, one window per job — is covered
 * in `browser-download.test.ts`; this file is about the scheduling and dedupe rules the API
 * promises, which are engine-independent.
 *
 * Nothing here is stubbed. The one thing it deliberately does not prove is the premise — the
 * file host is a local fixture, not a Cloudflare-protected origin.
 */

let gh: Harness;
let host: FileHost;
let dir: string;

const BODY = Buffer.alloc(256 * 1024, 42);

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
const poll = async (id: string, want: string, ms = 60_000): Promise<JobBody> => {
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

describe('the /gh/* surface on the real app', () => {
  // NOT a dedupe test, whatever it was once called: the first job settles before the second
  // POST, so the assertion is that dedupe deliberately does NOT apply. The window is
  // "unsettled records only", or a completed download would pin a caller to bytes it may
  // already have released. The real in-flight dedupe is the test after this one.
  it('starts a fresh job when the previous download of the same target has settled', async () => {
    const send = async (): Promise<string> => {
      const res = await fetch(`${gh.url}/gh/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: host.url, site: 'filehost' }),
      });
      expect(res.status).toBe(202);
      return ((await res.json()) as { jobId: string }).jobId;
    };

    const first = await send();
    expect((await poll(first, 'done')).state).toBe('done');

    const second = await send();
    expect(second).not.toBe(first);
    expect((await poll(second, 'done')).state).toBe('done');

    for (const id of [first, second]) await fetch(`${gh.url}/gh/jobs/${id}`, { method: 'DELETE' });
  }, 120_000);

  it('dedupes a second fetch onto the job that is still in flight', async () => {
    // A host that never answers is what holds the first job UNSETTLED long enough for the
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
      expect(second).toBe(first); // one record, one download, one set of bytes
    } finally {
      // Leave nothing running: this app is on the default windows, so only the DELETE frees
      // the slot before the suite ends.
      const dead = await fetch(`${gh.url}/gh/fetch`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      await fetch(`${gh.url}/gh/jobs/${((await dead.json()) as { jobId: string }).jobId}`, { method: 'DELETE' });
      await slowHost.close();
    }
  }, 60_000);

  /**
   * Finding: a host that goes quiet holds a concurrency slot with nothing able to settle it
   * but a caller DELETE. At the default of two slots, two such hosts wedge the whole download
   * surface while `/gh/fetch` keeps handing out 202s that never run.
   *
   * This runs a SECOND app of its own: one slot, so a wedged download starves everything, and
   * a 5s stall window (the configured minimum) so the test does not sit through the 120s
   * default. The no-start window is pinned high so what fires here is unambiguously the idle
   * watchdog and not `browserDownload`'s own request-phase timer, which would settle the same
   * record with a different message. The assertion is not just "the stalled job settled" — it
   * is that the job queued BEHIND it then ran to completion, which is what "the slot was
   * freed" actually means.
   */
  it('aborts a download that has gone idle, and frees the slot for the next one', async () => {
    const silentHost = await startFileHost({ mode: 'no-headers' });
    const goodHost = await startFileHost({ body: Buffer.alloc(64 * 1024, 3), filename: 'ok.bin' });
    const stallDir = await mkdtemp(join(tmpdir(), 'gh-stall-'));
    const app = await startGatehouse({
      GATEHOUSE_DOWNLOADS_DIR: stallDir,
      GATEHOUSE_DOWNLOAD_CONCURRENCY: '1',
      GATEHOUSE_DOWNLOAD_STALL_MS: '5000',
      GATEHOUSE_DOWNLOAD_NO_START_MS: '120000',
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

      // The premise: the silent download holds the only slot and the next job cannot start.
      await new Promise((r) => setTimeout(r, 1_000));
      expect((await state(silent)).state).toBe('running');
      expect((await state(behind)).state).toBe('queued');

      // The watchdog aborts, and it aborts WITH A REASON. The engine reads it off
      // `signal.reason` and settles a stall as the retryable host fault it is — `failed` /
      // `network` — rather than as `cancelled`, which would report the caller's own action back
      // to a caller that did nothing. Still one settle site; only the reason crossed.
      const stalled = await settleWithin(silent, 20_000);
      expect(stalled.state).toBe('failed');
      expect(stalled.error!.code).toBe('network');
      expect(stalled.error!.message).toMatch(/no bytes arrived/i);

      // The slot really was freed: the job behind it ran, and ran to completion.
      const next = await settleWithin(behind, 30_000);
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
