import { describe, it, expect, afterEach } from 'vitest';
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, serveFile } from '../../src/api/range.js';

describe('parseRange', () => {
  it('returns null when there is no Range header', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('', 100)).toBeNull();
  });
  it('parses a closed range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  });
  it('parses an open-ended range', () => {
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
  });
  it('parses a suffix range', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });
  it('clamps an end past EOF', () => {
    expect(parseRange('bytes=95-500', 100)).toEqual({ start: 95, end: 99 });
  });
  it('calls a start past EOF unsatisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=200-300', 100)).toBe('unsatisfiable');
  });
  it('calls a reversed or zero-suffix range unsatisfiable', () => {
    expect(parseRange('bytes=50-10', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
  it('ignores a unit it does not understand, rather than erroring', () => {
    expect(parseRange('items=0-9', 100)).toBeNull();
  });
  // A server MAY ignore Range. Serving the whole body is always correct; assembling a
  // multipart/byteranges response is not worth the surface for this consumer.
  it('ignores a multi-range request', () => {
    expect(parseRange('bytes=0-9,20-29', 100)).toBeNull();
  });
  it('ignores a garbage range', () => {
    expect(parseRange('bytes=abc', 100)).toBeNull();
    expect(parseRange('bytes=', 100)).toBeNull();
  });
  it('calls any range unsatisfiable for an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

describe('serveFile', () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (dir) await rm(dir, { recursive: true, force: true });
    server = undefined; dir = undefined;
  });

  async function host(body: string, contentType: string | null = 'application/octet-stream', filename: string | null = 'thing.bin') {
    dir = await mkdtemp(join(tmpdir(), 'gh-range-'));
    const path = join(dir, 'f.bin');
    await writeFile(path, body);
    server = createServer((req, res) => {
      void serveFile(req, res, { path, size: Buffer.byteLength(body), contentType, filename });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
  }

  it('serves the whole file with an accept-ranges header', async () => {
    const url = await host('0123456789');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('0123456789');
  });

  it('serves a 206 for a byte range', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { headers: { range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('serves a 206 for an open-ended range', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { headers: { range: 'bytes=7-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await res.text()).toBe('789');
  });

  it('answers 416 with a content-range and an explicit empty body', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { headers: { range: 'bytes=50-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
    expect(res.headers.get('content-length')).toBe('0');
    expect(await res.text()).toBe('');
  });

  it('serves a zero-byte file as an empty 200', async () => {
    const url = await host('');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('0');
    expect(await res.text()).toBe('');
  });

  it('answers HEAD with headers and no body', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('');
  });

  it('sets a content-disposition carrying the suggested filename', async () => {
    const url = await host('0123456789', 'application/zip', 'my file.zip');
    const res = await fetch(url);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain("filename*=UTF-8''my%20file.zip");
  });

  // A remote server chose this name. It must not be able to inject a header. Assert the
  // *encoded* form: reading a smuggled header back through an HTTP parser can never see one,
  // so only the encoding itself is real evidence.
  // The bound matters: a regression that leaves Node's own header validator to throw sends
  // no response at all, and without it this test would sit on the default timeout for a
  // minute on every mutation run.
  it('cannot be header-injected through the filename', async () => {
    const url = await host('0123456789', 'application/zip', 'evil\r\nX-Injected: yes\r\n.zip');
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('%0D%0A');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(res.headers.get('x-injected')).toBeNull();
  });

  // Encoding only CR/LF would still leave a header whose parameters a client mis-parses.
  it('encodes quotes and semicolons in the filename too', async () => {
    const url = await host('0123456789', 'application/zip', 'a"b;c.zip');
    const res = await fetch(url);
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''a%22b%3Bc.zip");
  });

  it('falls back to a generic content type when none is known', async () => {
    const url = await host('0123456789', null, null);
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  // The content type is as untrusted as the filename: it came from the same remote response.
  it('falls back when the content type carries a CRLF', async () => {
    const url = await host('0123456789', 'application/zip\r\nX-Injected: yes', 'thing.zip');
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-injected')).toBeNull();
  });

  it('falls back when the content type is nonsense', async () => {
    const url = await host('0123456789', 'not a media type at all', 'thing.zip');
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('keeps a legitimate content type with parameters', async () => {
    const url = await host('0123456789', 'application/zip; charset=utf-8', 'thing.zip');
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('application/zip; charset=utf-8');
  });

  // A gateway that dies when a file is missing or a client hangs up is a gateway that dies
  // every day. Both paths must be contained inside serveFile.
  it('answers 500 rather than a truncated 200 when the file is gone', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gh-range-'));
    const path = join(dir, 'absent.bin');
    server = createServer((req, res) => {
      void serveFile(req, res, { path, size: 10, contentType: null, filename: 'absent.bin' });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;

    const res = await fetch(url);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'file unavailable' });
  });

  it('survives a client that hangs up mid-download', async () => {
    const url = await host('x'.repeat(4 * 1024 * 1024));

    await new Promise<void>((resolve, reject) => {
      const request = get(url, (res) => {
        res.once('data', () => { request.destroy(); resolve(); });
        res.on('error', () => { /* expected: we tore the socket down */ });
      });
      request.on('error', () => { /* expected */ });
      request.setTimeout(5000, () => { request.destroy(); reject(new Error('no body arrived')); });
    });

    // The daemon is still here and still serving. An escaping ERR_STREAM_PREMATURE_CLOSE
    // would have surfaced as an unhandled rejection instead.
    const after = await fetch(url, { headers: { range: 'bytes=0-3' } });
    expect(after.status).toBe(206);
    expect(await after.text()).toBe('xxxx');
  });
});
