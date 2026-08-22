import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DownloadStore } from '../../src/downloads/store.js';
import type { DownloadRecord } from '../../src/downloads/record.js';
import { transfer, nodeRequester } from '../../src/downloads/transfer.js';
import { startFileHost, type FileHost } from '../fixture/filehost.js';

let dir: string; let host: FileHost | undefined; let n = 0;
const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const SHA = createHash('sha256').update(BODY).digest('hex');

const mkStore = () => new DownloadStore({ dir, now: () => 1000, idgen: () => `d${++n}`, ttlMs: 1e9, maxBytes: 1e12 });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gh-xfer-')); n = 0; });
afterEach(async () => { await host?.close(); host = undefined; await rm(dir, { recursive: true, force: true }); });

describe('transfer', () => {
  it('downloads a file, hashes it, and finalises the record', async () => {
    host = await startFileHost();
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    const done = s.get(r.id)!;
    expect(done.state).toBe('done');
    expect(done.size).toBe(BODY.length);
    expect(done.received).toBe(BODY.length);
    expect(done.sha256).toBe(SHA);
    expect(done.contentType).toBe('application/octet-stream');
    expect(done.suggestedName).toBe('thing.bin');
    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    await expect(stat(s.partPath(r.id))).rejects.toThrow(); // partial renamed away
  });

  it('resumes from a partial with a Range request', async () => {
    host = await startFileHost();
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await writeFile(s.partPath(r.id), BODY.subarray(0, 10));

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    expect(host.requests[0]?.range).toBe('bytes=10-');
    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    expect(s.get(r.id)?.sha256).toBe(SHA);
  });

  // A server that ignores Range sends the whole body from zero. Appending it to the partial
  // would silently corrupt the file, so the partial must be discarded first.
  it('restarts from zero when the server ignores Range', async () => {
    host = await startFileHost({ mode: 'no-range' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await writeFile(s.partPath(r.id), BODY.subarray(0, 10));

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    expect(s.get(r.id)?.sha256).toBe(SHA);
  });

  it('keeps the partial and fails when the connection drops mid-body', async () => {
    host = await startFileHost({ mode: 'truncate' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    const rec = s.get(r.id)!;
    expect(rec.state).toBe('failed');
    expect(rec.error?.code).toBe('network');
    const part = await stat(s.partPath(r.id));
    expect(part.size).toBeGreaterThan(0);
    expect(part.size).toBeLessThan(BODY.length);
  });

  it('resuming a truncated download completes it', async () => {
    host = await startFileHost({ mode: 'truncate' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await transfer(r.id, s, nodeRequester, new AbortController().signal);
    await host.close();

    host = await startFileHost({ mode: 'range' });
    await s.update(r.id, { url: host.url, state: 'queued' });
    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    expect(s.get(r.id)?.state).toBe('done');
    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    expect(s.get(r.id)?.sha256).toBe(SHA);
  });

  it('records an http-error for a non-2xx and writes no file', async () => {
    const s = mkStore(); await s.load();
    const r = await s.create({ url: 'http://127.0.0.1:1/nope', session: 'h', referer: null });
    await transfer(r.id, s, async () => ({ status: 404, headers: {}, body: (async function* () {})(), abort() {} }), new AbortController().signal);

    expect(s.get(r.id)?.state).toBe('failed');
    expect(s.get(r.id)?.error?.code).toBe('http-error');
    await expect(stat(s.filePath(r.id))).rejects.toThrow();
  });

  // An error body is still a body, and a body that is never read still owns its socket. The
  // rejection path has to hand that socket back or a run of 404s leaks one connection each.
  it('tears down the response body of a non-2xx', async () => {
    const s = mkStore(); await s.load();
    const r = await s.create({ url: 'http://127.0.0.1:1/nope', session: 'h', referer: null });
    let aborted = 0;
    await transfer(r.id, s, async () => ({
      status: 500,
      headers: { 'content-type': 'text/html' },
      body: (async function* () { yield new Uint8Array([1]); })(),
      abort() { aborted++; },
    }), new AbortController().signal);

    expect(s.get(r.id)?.state).toBe('failed');
    expect(aborted).toBe(1);
  });

  // `Number('')` is 0, so a *missing* content-length used to read as "an empty body" and every
  // chunked response — routine for generated and proxied downloads — was recorded as a short
  // read, permanently: the retained partial was complete, so the retry earned a 416.
  it('completes a chunked response that declares no length', async () => {
    host = await startFileHost({ mode: 'chunked' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    const rec = s.get(r.id)!;
    expect(rec.state).toBe('done');
    expect(rec.error).toBeUndefined();
    expect(rec.received).toBe(BODY.length);
    expect(rec.size).toBe(BODY.length); // -1 while unknown, replaced by what actually arrived
    expect(rec.sha256).toBe(SHA);
    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
  });

  // A cancel that lands before the response headers do. The signal is wired to the response,
  // so if the requester does not honour it too, this promise never settles and the record is
  // stuck `running` where no retention sweep may touch it.
  it('settles as cancelled when the cancel lands during the request phase', async () => {
    host = await startFileHost({ mode: 'no-headers' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    const ac = new AbortController();
    const p = transfer(r.id, s, nodeRequester, ac.signal);
    setTimeout(() => ac.abort(), 100);
    const outcome = await Promise.race([
      p.then(() => 'settled'),
      new Promise<string>((res) => setTimeout(() => res('still pending'), 1500)),
    ]);

    expect(outcome).toBe('settled');
    expect(s.get(r.id)?.state).toBe('cancelled');
    expect(s.get(r.id)?.error?.code).toBe('cancelled');
  });

  // A 206 is a claim, not evidence. Proxies answer a ranged request with 206 and then send the
  // whole file from zero; appending that to the partial is the silent corruption this module
  // exists to prevent, so the content-range has to be read and checked.
  it('discards the partial when a 206 lies about its content-range', async () => {
    host = await startFileHost({ mode: 'lying-206' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await writeFile(s.partPath(r.id), BODY.subarray(0, 10));

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    expect(host.requests[0]?.range).toBe('bytes=10-'); // it really was asked to resume
    expect(s.get(r.id)?.state).toBe('done');
    expect(await readFile(s.filePath(r.id))).toEqual(BODY); // not 10 stale bytes + 36 more
    expect(s.get(r.id)?.sha256).toBe(SHA);
  });

  it('cancels and deletes the partial when the signal aborts', async () => {
    host = await startFileHost({ mode: 'stall' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    const ac = new AbortController();
    const p = transfer(r.id, s, nodeRequester, ac.signal);
    await new Promise((res) => setTimeout(res, 150));
    ac.abort();
    await p;

    expect(s.get(r.id)?.state).toBe('cancelled');
    expect(s.get(r.id)?.error?.code).toBe('cancelled');
    await expect(stat(s.partPath(r.id))).rejects.toThrow();
  });

  // The point of this one is the *mid-transfer* updates, not the terminal record — a terminal
  // assertion alone passes with the throttled update deleted. The threshold is injected because
  // the real 4MB one would need a 4MB body to cross, which is not a unit test.
  it('reports progress as bytes arrive', async () => {
    const size = 200_000;
    host = await startFileHost({ body: Buffer.alloc(size, 7) });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    // A progress update is a patch of exactly `{ received }`; the opening and closing updates
    // both carry other keys, so this sees only the throttled ones.
    const midway: number[] = [];
    const update = s.update.bind(s);
    s.update = async (id: string, patch: Partial<DownloadRecord>) => {
      if (Object.keys(patch).length === 1 && patch.received !== undefined) midway.push(patch.received);
      return update(id, patch);
    };

    await transfer(r.id, s, nodeRequester, new AbortController().signal, 8 * 1024);

    expect(midway.length).toBeGreaterThan(0);
    expect(midway.some((v) => v > 0 && v < size)).toBe(true);
    expect(midway).toEqual([...midway].sort((a, b) => a - b)); // monotonic
    const rec = s.get(r.id)!;
    expect(rec.received).toBe(size);
    expect(rec.size).toBe(size);
  });
});
