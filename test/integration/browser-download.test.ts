import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startGatehouse, type Harness } from './harness.js';
import { startFileHost, type FileHost } from '../fixture/filehost.js';

/**
 * The download engine, end to end through the REAL built app: `/gh/fetch` accepted by the
 * shipped server, the bytes pulled by **Chromium's own download stack** on a persistent
 * partition, recorded by `DownloadStore`, and served back by the Range file server.
 *
 * The engine is what changed. `net.request` is gone: measured against a real
 * challenge-protected host, every `net.request` variant was refused 403 while holding a valid
 * clearance in the same partition, and only `webContents.downloadURL` → `will-download`
 * returned real content. Everything below therefore drives the browser, and the properties it
 * asserts are the ones that only matter *because* the browser is driving.
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
  dir = await mkdtemp(join(tmpdir(), 'gh-bdl-'));
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

const SETTLED = ['done', 'failed', 'cancelled'];

const job = async (base: string, id: string): Promise<JobBody> =>
  (await (await fetch(`${base}/gh/jobs/${id}`)).json()) as JobBody;

/** POST a target and return its job id, asserting the 202 on the way through. */
const fetchJob = async (base: string, url: string, site: string): Promise<string> => {
  const res = await fetch(`${base}/gh/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, site }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { jobId: string; state: string };
  expect(body.state).toBe('queued');
  return body.jobId;
};

/**
 * Poll until the job settles, or the deadline passes. It RETURNS the unsettled record rather
 * than throwing on a timeout, so a regression fails on an assertion naming the state it was
 * stuck in rather than on an opaque suite timeout.
 */
const settle = async (base: string, id: string, ms = 60_000): Promise<JobBody> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = await job(base, id);
    if (SETTLED.includes(body.state)) return body;
    if (Date.now() > deadline) return body;
    await new Promise((r) => setTimeout(r, 150));
  }
};

describe('downloading through the browser stack', () => {
  let id: string;

  it('completes a download and hands back the right bytes', async () => {
    id = await fetchJob(gh.url, host.url, 'filehost');

    const done = await settle(gh.url, id);
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
    // The `.part` was renamed, not copied: nothing is left behind under this id but the file.
    expect((await readdir(dir)).filter((f) => f.startsWith(id))).toEqual([`${id}.bin`]);
  }, 90_000);

  it('serves the bytes back whole and by range', async () => {
    const whole = await fetch(`${gh.url}/gh/files/${id}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await whole.arrayBuffer()).equals(BODY)).toBe(true);

    const part = await fetch(`${gh.url}/gh/files/${id}`, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${BODY.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(BODY.subarray(100, 200))).toBe(true);
  }, 60_000);

  /**
   * THE regression net for one hidden window per job.
   *
   * `will-download` fires on the SESSION, not the window, so the handler's only question is
   * "is this item mine?". For two downloads in flight at once against the same host, every
   * field on the item — filename, mime type, total bytes, eTag — is identical, and fire order
   * does not match call order. The `webContents` argument is the only discriminator there is.
   * Give both jobs one shared window and they become indistinguishable: one adopts the other's
   * item, a save path is set twice on one item and never on the other, and at least one job
   * settles wrong. Verified by doing exactly that and watching this test go red.
   *
   * Both jobs run on the SAME session on purpose — that is what puts both `will-download`
   * listeners on one emitter, which is the situation being tested. The URLs differ only by a
   * query the fixture ignores, because `findOpen` folds two requests for an identical
   * session+url onto one record by design: two concurrent jobs for a byte-identical response
   * is the closest the public API can get, and nothing in the correlation reads the URL, so it
   * is the same test.
   */
  it('runs two concurrent downloads of the same target without crossing them', async () => {
    const [a, b] = await Promise.all([
      fetchJob(gh.url, `${host.url}?job=a`, 'concurrent'),
      fetchJob(gh.url, `${host.url}?job=b`, 'concurrent'),
    ]);
    expect(a).not.toBe(b); // two records, two windows, two items

    const [doneA, doneB] = await Promise.all([settle(gh.url, a), settle(gh.url, b)]);
    for (const [which, body] of [['a', doneA], ['b', doneB]] as const) {
      expect(body.state, which).toBe('done');
      expect(body.result!.size, which).toBe(BODY.length);
      expect(body.result!.sha256, which).toBe(SHA);
    }
    // Each landed in its own file. A shared item would have written one of these and left the
    // other missing.
    expect((await stat(doneA.result!.path)).size).toBe(BODY.length);
    expect((await stat(doneB.result!.path)).size).toBe(BODY.length);
    expect(doneA.result!.path).not.toBe(doneB.result!.path);

    for (const each of [a, b]) await fetch(`${gh.url}/gh/jobs/${each}`, { method: 'DELETE' });
  }, 120_000);

  /**
   * A server that sends no `Content-Length` — a chunked response, which includes any brotli
   * one — leaves `item.getTotalBytes()` at 0 until the download completes. Writing that 0 into
   * the record would tell a caller the file is zero bytes long; the record's own convention
   * for "unknown" is -1, and the engine translates. The paced fixture is what makes this
   * observable at all: the record is created with -1, so only a look *during* the transfer,
   * after the headers were read, proves the translation rather than the initial value.
   */
  it('reports an unknown total as -1 rather than 0 for a chunked response', async () => {
    // Over the 4MB progress throttle, so `received` genuinely advances mid-transfer and the
    // observation below is of a record whose headers have been read.
    const chunkedBody = Buffer.alloc(12 * 1024 * 1024, 7);
    const chunkedSha = createHash('sha256').update(chunkedBody).digest('hex');
    const chunkedHost = await startFileHost({
      mode: 'chunked', body: chunkedBody, filename: 'stream.bin', chunks: 6, chunkDelayMs: 250,
    });
    try {
      const chunkedId = await fetchJob(gh.url, chunkedHost.url, 'chunked');

      const totals: number[] = [];
      let sawUnknownWhileRunning = false;
      const deadline = Date.now() + 60_000;
      let last: JobBody;
      for (;;) {
        last = await job(gh.url, chunkedId);
        totals.push(last.progress.total);
        if (last.state === 'running' && last.progress.received > 0 && last.progress.total === -1) {
          sawUnknownWhileRunning = true;
        }
        if (SETTLED.includes(last.state) || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(last.state).toBe('done');
      expect(last.result!.sha256).toBe(chunkedSha);
      expect(last.result!.size).toBe(chunkedBody.length);
      // Never 0 — not once, at any point in the download's life.
      expect(totals.filter((t) => t === 0)).toEqual([]);
      expect(sawUnknownWhileRunning).toBe(true);

      await fetch(`${gh.url}/gh/jobs/${chunkedId}`, { method: 'DELETE' });
    } finally {
      await chunkedHost.close();
    }
  }, 120_000);

  /**
   * A cancel while bytes are genuinely on disk. The paced host is what makes it a MID-BODY
   * cancel rather than a request-phase one: the wait below does not move on until a `.part`
   * exists, so there is a live `DownloadItem` with an open file when the DELETE lands.
   *
   * Chromium deletes the partial of an item it cancelled, and the engine unlinks unconditionally
   * on top of that, so the directory is left with nothing under this id.
   */
  it('cancels a download in flight, settles cancelled, and leaves no partial', async () => {
    const slowHost = await startFileHost({
      mode: 'chunked', body: Buffer.alloc(24 * 1024 * 1024, 9), chunks: 24, chunkDelayMs: 250,
    });
    try {
      const slowId = await fetchJob(gh.url, slowHost.url, 'cancelme');

      const partDeadline = Date.now() + 30_000;
      let sawPart = false;
      while (Date.now() < partDeadline) {
        if ((await readdir(dir)).includes(`${slowId}.part`)) { sawPart = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Not incidental: without it this test would silently degrade into the request-phase
      // cancel, which proves far less.
      expect(sawPart, 'no partial appeared, so this was not a mid-body cancel').toBe(true);
      expect((await job(gh.url, slowId)).state).toBe('running');

      expect((await fetch(`${gh.url}/gh/jobs/${slowId}`, { method: 'DELETE' })).status).toBe(204);
      const settled = await settle(gh.url, slowId, 30_000);
      expect(settled.state).toBe('cancelled');
      expect(settled.error!.code).toBe('cancelled');

      expect((await readdir(dir)).filter((f) => f.startsWith(slowId))).toEqual([]);
    } finally {
      await slowHost.close();
    }
  }, 120_000);

  it('releases the bytes on DELETE of a completed job', async () => {
    const path = (await job(gh.url, id)).result!.path;
    expect((await fetch(`${gh.url}/gh/jobs/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${gh.url}/gh/jobs/${id}`)).status).toBe(404);
    expect((await fetch(`${gh.url}/gh/files/${id}`)).status).toBe(404);
    await expect(stat(path)).rejects.toThrow();
  }, 60_000);
});

/**
 * A host that accepts the socket and then writes nothing NEVER fires `will-download` — measured
 * at 150s with no timeout, no error and nothing to cancel, because no `DownloadItem` was ever
 * created. `GATEHOUSE_DOWNLOAD_NO_START_MS` is the only thing that ends that, and it names the
 * fault rather than calling it a stall: nothing began.
 *
 * Its own app, with the setting at its 5000ms floor, so the test does not sit through the 60s
 * default. The upper bound asserted below is what makes this a test of the timer rather than of
 * patience.
 */
describe('a host that never starts the download', () => {
  it('fails network within the configured no-start window rather than hanging', async () => {
    const silent = await startFileHost({ mode: 'no-headers' });
    const silentDir = await mkdtemp(join(tmpdir(), 'gh-nostart-'));
    const app = await startGatehouse({
      GATEHOUSE_DOWNLOADS_DIR: silentDir,
      GATEHOUSE_DOWNLOAD_NO_START_MS: '5000',
      // Comfortably above the no-start window, so what fires below is unambiguously the
      // no-start timer and not the idle watchdog.
      GATEHOUSE_DOWNLOAD_STALL_MS: '60000',
    });
    try {
      const started = Date.now();
      const silentId = await fetchJob(app.url, silent.url, 'silenthost');
      const settled = await settle(app.url, silentId, 40_000);
      const took = Date.now() - started;

      expect(settled.state).toBe('failed');
      expect(settled.error!.code).toBe('network');
      expect(settled.error!.message).toMatch(/never started/i);
      // The window plus slack for the spawn and the poll interval — not the 60s stall window,
      // and emphatically not forever.
      expect(took).toBeLessThan(25_000);
      expect((await readdir(silentDir)).filter((f) => f.startsWith(silentId))).toEqual([]);
    } finally {
      await app.stop();
      await silent.close();
      await rm(silentDir, { recursive: true, force: true });
    }
  }, 120_000);
});
