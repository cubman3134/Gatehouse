import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DownloadStore } from '../../src/downloads/store.js';
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

  it('reports progress as bytes arrive', async () => {
    host = await startFileHost({ body: Buffer.alloc(200_000, 7) });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    const rec = s.get(r.id)!;
    expect(rec.received).toBe(200_000);
    expect(rec.size).toBe(200_000);
  });
});
