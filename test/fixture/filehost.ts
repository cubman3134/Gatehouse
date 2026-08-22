import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FileHost {
  url: string;
  /** Every request's Range header, in order — how a test proves a resume actually resumed. */
  requests: Array<{ range: string | undefined }>;
  close(): Promise<void>;
}

export interface FileHostOptions {
  /**
   * 'range'    — honours Range with a 206 (the good case).
   * 'no-range' — ignores Range and always sends the whole body with a 200.
   * 'truncate' — sends half the body then destroys the socket, to force a resume.
   * 'stall'    — sends headers and one byte, then nothing, forever.
   */
  mode?: 'range' | 'no-range' | 'truncate' | 'stall';
  body?: Buffer;
  filename?: string;
}

/** How long 'truncate' mode lets the body flow before it kills the socket. See the use site. */
const TRUNCATE_DROP_MS = 100;

export async function startFileHost(opts: FileHostOptions = {}): Promise<FileHost> {
  const mode = opts.mode ?? 'range';
  const body = opts.body ?? Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const filename = opts.filename ?? 'thing.bin';
  const requests: Array<{ range: string | undefined }> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ range: req.headers.range });

    const common = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'accept-ranges': 'bytes',
    };

    if (mode === 'stall') {
      res.writeHead(200, { ...common, 'content-length': String(body.length) });
      res.write(body.subarray(0, 1));
      return; // never ends
    }

    let slice = body;
    let status = 200;
    const headers: Record<string, string> = { ...common };

    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m && mode !== 'no-range') {
      const start = Number(m[1]);
      if (start >= body.length) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }); res.end(); return; }
      slice = body.subarray(start);
      status = 206;
      headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }

    if (mode === 'truncate') {
      headers['content-length'] = String(slice.length);
      res.writeHead(status, headers);
      // The drop has to land *after* the client has started reading, or this mode simulates
      // the wrong fault. Two things bite here. Destroying the socket in the same tick as the
      // write discards everything still queued on it, head included, so the client gets a bare
      // "socket hang up" and never sees a response at all. And destroying it before the client
      // pulls throws away Node's read buffer with it — a reader gets 0 bytes, so a test that
      // means to assert "the partial survived a mid-body drop" would be asserting nothing.
      // A reader's setup window is ~1-3ms; this is deliberately far clear of it.
      res.write(slice.subarray(0, Math.floor(slice.length / 2)), () => {
        setTimeout(() => res.socket?.destroy(), TRUNCATE_DROP_MS);
      });
      return;
    }

    headers['content-length'] = String(slice.length);
    res.writeHead(status, headers);
    res.end(slice);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
