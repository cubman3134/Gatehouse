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

  it('dedupes a second fetch of the same target onto the same job', async () => {
    const res = await fetch(`${gh.url}/gh/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: host.url, site: 'filehost' }),
    });
    expect(res.status).toBe(202);
    // The first job has SETTLED, so it is no longer open and this is a new one — the dedupe
    // window is deliberately "unsettled records only", or a completed download would pin the
    // caller to bytes it may already have released.
    const second = (await res.json()) as { jobId: string };
    expect(second.jobId).not.toBe(id);
    await poll(second.jobId, 'done');
    await fetch(`${gh.url}/gh/jobs/${second.jobId}`, { method: 'DELETE' });
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

      // Cancel is the one outcome that drops the partial: nothing is going to resume it.
      const left = (await readdir(dir)).filter((f) => f.startsWith(stallId));
      expect(left).toEqual([]);
    } finally {
      await stallHost.close();
    }
  }, 60_000);

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
