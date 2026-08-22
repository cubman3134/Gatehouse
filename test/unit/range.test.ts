import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
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
    expect(await res.text()).toBe('789');
  });

  it('answers 416 with a content-range for an unsatisfiable range', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { headers: { range: 'bytes=50-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
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

  // A remote server chose this name. It must not be able to inject a header.
  it('cannot be header-injected through the filename', async () => {
    const url = await host('0123456789', 'application/zip', 'evil\r\nX-Injected: yes\r\n.zip');
    const res = await fetch(url);
    expect(res.headers.get('x-injected')).toBeNull();
    expect(res.headers.get('content-disposition') ?? '').not.toContain('\n');
  });

  it('falls back to a generic content type when none is known', async () => {
    const url = await host('0123456789', null, null);
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});
