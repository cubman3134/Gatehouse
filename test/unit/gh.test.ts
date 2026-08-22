import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadStore } from '../../src/downloads/store.js';
import { handleGh, type GhDeps } from '../../src/api/gh.js';

let dir: string; let server: Server; let base: string; let store: DownloadStore;
let submitted: string[]; let cancelled: string[]; let n = 0; let clock = 1000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-api-')); n = 0; clock = 1000;
  submitted = []; cancelled = [];
  store = new DownloadStore({ dir, now: () => clock, idgen: () => `d${++n}`, ttlMs: 1e9, maxBytes: 1e12 });
  await store.load();
  const deps: GhDeps = { store, submit: (id) => submitted.push(id), cancel: (id) => cancelled.push(id), now: () => clock };
  server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (!(await handleGh(req, res, path, deps))) { res.writeHead(404); res.end(); }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${base}/gh/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /gh/fetch', () => {
  it('answers 202 with a job id and schedules the work', async () => {
    const res = await post({ url: 'http://example.test/f.bin' });
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.jobId).toBe('d1');
    expect(body.state).toBe('queued');
    expect(submitted).toEqual(['d1']);
    expect(store.get('d1')?.session).toBe('example.test');
  });

  it('dedupes an in-flight request for the same target', async () => {
    await post({ url: 'http://example.test/f.bin' });
    const again = await post({ url: 'http://example.test/f.bin' });
    expect(((await again.json()) as any).jobId).toBe('d1');
    expect(submitted).toEqual(['d1']); // scheduled once, not twice
  });

  // `transfer` keeps a partial on every failure so a later attempt can resume from it. Outside
  // a restart, THIS is the attempt: a re-POST takes the failed record over under its own id
  // rather than minting a new one, or a 40GB download restarts from zero after a blip and the
  // kept bytes are orphaned until the sweep.
  it('resumes a transiently-failed download under its existing job id', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await writeFile(store.partPath('d1'), 'the bytes we already have');
    await store.update('d1', { state: 'failed', received: 25, error: { code: 'network', message: 'connection reset' }, completedAt: clock });
    submitted.length = 0;

    const res = await post({ url: 'http://example.test/f.bin' });
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.jobId).toBe('d1'); // the same id, not a fresh d2
    expect(body.state).toBe('queued');
    expect(submitted).toEqual(['d1']);
    // Unsettled again, and the stale failure cleared — or `/gh/jobs/d1` would report a queued
    // job that also carries an error, and `findOpen` would not fold the next request onto it.
    const rec = store.get('d1')!;
    expect(rec.state).toBe('queued');
    expect(rec.error).toBeUndefined();
    expect(rec.completedAt).toBeNull();
    expect(rec.received).toBe(25); // the progress it resumes from
  });

  it('does not resume a permanent failure or a cancel', async () => {
    for (const [url, patch] of [
      ['http://example.test/a.bin', { state: 'failed' as const, error: { code: 'http-error' as const, message: '404' } }],
      ['http://example.test/b.bin', { state: 'failed' as const, error: { code: 'disk-full' as const, message: 'ENOSPC' } }],
      ['http://example.test/c.bin', { state: 'cancelled' as const, error: { code: 'cancelled' as const, message: 'cancelled by the caller' } }],
    ] as const) {
      const first = ((await (await post({ url })).json()) as any).jobId as string;
      await writeFile(store.partPath(first), 'leftovers');
      await store.update(first, { ...patch, completedAt: clock });
      const again = ((await (await post({ url })).json()) as any).jobId as string;
      expect(again, url).not.toBe(first); // a fresh id, a fresh download
    }
  });

  it('does not resume a failure whose partial is gone', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'failed', error: { code: 'network', message: 'reset' }, completedAt: clock });
    expect(((await (await post({ url: 'http://example.test/f.bin' })).json()) as any).jobId).toBe('d2');
  });

  it('rejects a file: url with our error shape', async () => {
    const res = await post({ url: 'file:///C:/secrets.txt' });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toMatch(/scheme/);
    expect(submitted).toEqual([]);
  });

  // The one caller-supplied field forwarded to a third party as an outbound header.
  it('rejects a referer that is not an http(s) URL', async () => {
    const CRLF = String.fromCharCode(13, 10);
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'not a url', 'evil' + CRLF + 'X: 1']) {
      // Bounded: without the guard the handler can throw and never answer, and a test that can
      // only fail by wall-clock timeout is the failure mode this project keeps re-learning.
      const res = await fetch(`${base}/gh/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://example.test/f.bin', referer: bad }),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => null);
      expect(res, `referer ${JSON.stringify(bad)}: no response arrived`).not.toBeNull();
      expect(res!.status, `referer ${JSON.stringify(bad)} should be refused`).toBe(400);
    }
    expect(submitted).toEqual([]);
  });

  it('accepts and normalises a valid referer', async () => {
    const res = await post({ url: 'http://example.test/f.bin', referer: 'https://example.test' });
    expect(res.status).toBe(202);
    expect(store.get('d1')?.referer).toBe('https://example.test/');
  });

  it('rejects a hostile session name', async () => {
    const res = await post({ url: 'http://example.test/f.bin', site: '../../etc' });
    expect(res.status).toBe(400);
    expect(submitted).toEqual([]);
  });

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${base}/gh/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(res.status).toBe(400);
  });

  it('405s a GET', async () => {
    expect((await fetch(`${base}/gh/fetch`)).status).toBe(405);
  });

  // Answer-then-drain, the shape `/v1` already uses. Resolving the read stops US buffering, but
  // it does not stop the client: ending the response while unread inbound data is still
  // arriving makes the OS send RST rather than FIN, and an RST discards the 400 sitting in the
  // client's receive buffer. The client would see ECONNRESET instead of the refusal.
  it('answers an oversized body with a 400 the client actually receives', async () => {
    const u = new URL(`${base}/gh/fetch`);
    const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(
        { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { text += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('error', reject);
      // Well past the 64KB cap and written in pieces, so the crossing lands mid-upload with
      // plenty still to come — which is the only arrangement that can produce the reset.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      for (let i = 0; i < 8; i++) req.write(chunk);
      req.end();
    });
    expect(answer.status).toBe(400);
    expect((JSON.parse(answer.text) as any).error.code).toBe('bad-request');
    expect(submitted).toEqual([]);
  });
});

describe('GET /gh/jobs/:id', () => {
  it('reports progress for a running download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'running', size: 100, received: 40 });
    const body = await (await fetch(`${base}/gh/jobs/d1`)).json() as any;
    expect(body.state).toBe('running');
    expect(body.progress).toEqual({ received: 40, total: 100 });
    expect(body.result).toBeUndefined();
  });

  it('returns path, url, size and sha256 for a completed download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'done', size: 3, received: 3, sha256: 'aa', suggestedName: 'f.bin', contentType: 'application/zip' });
    const body = await (await fetch(`${base}/gh/jobs/d1`)).json() as any;
    expect(body.state).toBe('done');
    expect(body.result.path).toBe(store.filePath('d1'));
    expect(body.result.url).toBe('/gh/files/d1');
    expect(body.result.size).toBe(3);
    expect(body.result.sha256).toBe('aa');
    expect(body.result.filename).toBe('f.bin');
  });

  it('reports the failure code for a failed download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'failed', error: { code: 'http-error', message: 'server answered 404' } });
    const body = await (await fetch(`${base}/gh/jobs/d1`)).json() as any;
    expect(body.state).toBe('failed');
    expect(body.error).toEqual({ code: 'http-error', message: 'server answered 404' });
  });

  it('404s an unknown id', async () => {
    const res = await fetch(`${base}/gh/jobs/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('not-found');
  });
});

describe('DELETE /gh/jobs/:id', () => {
  it('cancels an in-flight download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'running' });
    const res = await fetch(`${base}/gh/jobs/d1`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(cancelled).toEqual(['d1']);
    // Cancelling is asynchronous. The record must SURVIVE the DELETE: the transfer still owns
    // an open handle on the `.part`, and it is the writer that settles the record once it has
    // closed. Removing it here would unlink a file the OS still has open for writing.
    expect(store.get('d1')?.state).toBe('running');
  });

  it('releases a completed download and its bytes', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await writeFile(store.filePath('d1'), 'abc');
    await store.update('d1', { state: 'done', size: 3, received: 3 });
    expect((await fetch(`${base}/gh/jobs/d1`, { method: 'DELETE' })).status).toBe(204);
    expect(store.get('d1')).toBeUndefined();
    expect((await fetch(`${base}/gh/jobs/d1`)).status).toBe(404);
  });

  it('404s an unknown id', async () => {
    expect((await fetch(`${base}/gh/jobs/nope`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /gh/files/:id', () => {
  it('serves the bytes with Range support and bumps lastAccessAt', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await writeFile(store.filePath('d1'), '0123456789');
    await store.update('d1', { state: 'done', size: 10, received: 10, suggestedName: 'f.bin', lastAccessAt: 1000 });

    clock = 5000;
    const whole = await fetch(`${base}/gh/files/d1`);
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('0123456789');
    expect(store.get('d1')?.lastAccessAt).toBe(5000);

    const part = await fetch(`${base}/gh/files/d1`, { headers: { range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('234');
  });

  it('409s a download that is not finished', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'running' });
    const res = await fetch(`${base}/gh/files/d1`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('not-ready');
  });

  it('404s an unknown id', async () => {
    expect((await fetch(`${base}/gh/files/nope`)).status).toBe(404);
  });

  // The id indexes a map we populated. It must never be joined into a path.
  it('cannot be path-traversed through the id', async () => {
    for (const id of ['..%2F..%2Fmanifest.json', '..', '%2e%2e%2f%2e%2e%2fmanifest.json']) {
      const res = await fetch(`${base}/gh/files/${id}`);
      expect([404, 400]).toContain(res.status);
    }
  });
});
