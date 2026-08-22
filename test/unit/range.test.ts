import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, serveFile } from '../../src/api/range.js';
import { log } from '../../src/log.js';

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
    vi.restoreAllMocks();
  });

  /**
   * A request that resolves to `null` instead of hanging when no response ever arrives.
   *
   * A header value Node refuses makes `writeHead` throw, and a throw there means the client is
   * left holding an open socket forever. Collapsing that into `null` is what lets these tests
   * fail on an assertion — "no response at all" — instead of sitting on a timeout, which is
   * both slower and a far worse failure message to read.
   */
  async function fetchOrNull(url: string, init?: RequestInit): Promise<Response | null> {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(2_000), ...init });
    } catch {
      return null;
    }
  }

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

  // The parameter tail of a media type is where an upstream filename ends up, and Node's
  // outgoing-header validator refuses a strictly larger character set than any shape check
  // spells out: every C0 control bar HT/LF/CR/NUL, DEL, and everything above Latin-1. Each of
  // these once threw inside `writeHead` *after* the descriptor was open — an unhandled
  // rejection and a leaked fd, from a header a remote server chose. Assert a served response,
  // because "no response" is the shape that regression takes.
  it.each([
    ['a non-Latin-1 character', 'application/zip; name=€.zip'],
    ['a CJK parameter', 'video/mp4; title=中文'],
    ['a C0 control', `application/zip; x=${String.fromCharCode(0x01)}y`],
    ['a DEL', `application/zip; x=${String.fromCharCode(0x7f)}y`],
  ])('serves a safe content type when the upstream one carries %s', async (_label, contentType) => {
    const url = await host('0123456789', contentType, 'thing.zip');
    const res = await fetchOrNull(url);
    expect(res, 'no response arrived: writeHead threw on the content-type').not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res!.text()).toBe('0123456789');
  });

  // A truncated upstream filename carries half a surrogate pair, and `encodeURIComponent`
  // throws URIError on one. That ran before the stream opened, so it leaked nothing — it just
  // killed the process.
  it('serves a sane disposition when the filename holds a lone surrogate', async () => {
    const url = await host('0123456789', 'application/zip', 'bad\ud800name.zip');
    const res = await fetchOrNull(url);
    expect(res, 'no response arrived: the filename encode threw').not.toBeNull();
    expect(res!.status).toBe(200);
    const cd = res!.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).not.toMatch(/[\r\n]/);
    expect(await res!.text()).toBe('0123456789');
  });

  // "the connection went away mid-stream" is the line someone reads at 3am. A truncated file,
  // a revoked permission or a disk fault must not arrive wearing a client's clothes.
  it('reports a server-side read fault as an error, not as a client hang-up', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    dir = await mkdtemp(join(tmpdir(), 'gh-range-'));
    server = createServer((req, res) => {
      // A directory where a file is expected: it opens, then faults on the first read.
      void serveFile(req, res, { path: dir!, size: 4096, contentType: null, filename: 'd' });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    await fetchOrNull(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`);
    await new Promise<void>((r) => setTimeout(r, 100));

    expect(error).toHaveBeenCalledWith(
      expect.not.stringContaining('connection went away'),
      expect.objectContaining({ reason: expect.stringContaining('EISDIR') }),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('connection went away'),
      expect.anything(),
    );
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
