import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

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
   * 'stall'      — sends headers and one byte, then nothing, forever.
   * 'chunked'    — no content-length at all, body in Transfer-Encoding chunks, as a
   *                dynamically generated or proxied download arrives.
   * 'no-headers' — accepts the socket and sends nothing, ever: not even a status line. This is
   *                the request phase hanging, which is a different fault from 'stall'.
   * 'shifted-206' — answers a ranged request with 206 from a THIRD offset (5), neither what
   *                 was asked for nor zero. Its body cannot be placed correctly either way.
   * 'lying-206'  — answers a ranged request with 206 but a content-range of `bytes 0-n-1/n`
   *                and the whole body, the way some proxies and CDNs do. Appending that to a
   *                partial is exactly the silent corruption the transfer guard exists to stop.
   * 'headerless-206' — HONOURS the range (sends only the tail) with a 206, but omits
   *                `content-range` entirely. RFC 9110 requires the header; sloppy proxies drop
   *                it anyway. Nothing in the response says where the body starts, so treating
   *                it as "the range was ignored" and restarting from zero would write the tail
   *                as if it were the whole file — a `done` record with a valid-looking sha256
   *                of the wrong bytes.
   */
  mode?: 'range' | 'no-range' | 'truncate' | 'stall' | 'chunked' | 'no-headers' | 'lying-206' | 'shifted-206' | 'headerless-206';
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

    if (mode === 'no-headers') return; // socket accepted, nothing ever written

    if (mode === 'stall') {
      res.writeHead(200, { ...common, 'content-length': String(body.length) });
      res.write(body.subarray(0, 1));
      return; // never ends
    }

    if (mode === 'chunked') {
      // Omitting content-length is what makes Node frame this as chunked; two writes so the
      // body genuinely arrives in more than one chunk.
      res.writeHead(200, common);
      const half = Math.ceil(body.length / 2);
      res.write(body.subarray(0, half));
      res.end(body.subarray(half));
      return;
    }

    if (mode === 'shifted-206') {
      const from = 5;
      res.writeHead(206, {
        ...common,
        'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
        'content-length': String(body.length - from),
      });
      res.end(body.subarray(from));
      return;
    }

    if (mode === 'headerless-206') {
      // Deliberately the COMPLIANT-but-headerless case: the range really is honoured, so the
      // body is the tail and nothing but the missing header makes it unplaceable.
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const from = m ? Number(m[1]) : 0;
      const slice = body.subarray(from);
      res.writeHead(206, { ...common, 'content-length': String(slice.length) });
      res.end(slice);
      return;
    }

    if (mode === 'lying-206') {
      res.writeHead(206, {
        ...common,
        'content-range': `bytes 0-${body.length - 1}/${body.length}`,
        'content-length': String(body.length),
      });
      res.end(body);
      return;
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

  // `server.close` waits for every open connection to end on its own, and the modes above are
  // built precisely not to end. Hold the sockets so close() can cut them.
  const sockets = new Set<Socket>();
  server.on('connection', (s: Socket) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`,
    requests,
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      for (const s of sockets) s.destroy();
    }),
  };
}
