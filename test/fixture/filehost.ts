import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface FileHost {
  url: string;
  close(): Promise<void>;
}

export interface FileHostOptions {
  /**
   * 'range'      — honours Range with a 206 (the good case, and the default).
   * 'chunked'    — no content-length at all, body in Transfer-Encoding chunks, as a
   *                dynamically generated or proxied download arrives.
   * 'no-headers' — accepts the socket and sends nothing, ever: not even a status line. The
   *                request phase hanging, with no `DownloadItem` ever created.
   *
   * There used to be six more — 'no-range', 'truncate', 'lying-206', 'shifted-206',
   * 'headerless-206' and 'stall' — and they are gone rather than merely unused. They existed to
   * drive the byte-stream transfer's range guards: that engine placed a response body into the
   * file itself, so a 200 answering a Range, or a 206 from an offset nobody asked for, was a
   * corruption it had to refuse. Chromium owns range handling now and offers no such seam. The
   * safety that replaced those guards is upstream and needs no host to misbehave: without an
   * `eTag` or a `Last-Modified` we do not ask for a continuation at all — see `resumable.ts`,
   * which is unit-tested directly.
   */
  mode?: 'range' | 'chunked' | 'no-headers';
  body?: Buffer;
  filename?: string;
  /**
   * `chunked` only: how many pieces the body is written in, and how long to pause between
   * them. The defaults (2, 0ms) are the original behaviour — a body that arrives in more than
   * one chunk, as fast as the socket takes it.
   *
   * Pacing exists so a test can observe a download *while it is running* rather than only
   * after it settled. `progress.total` is `-1` from the moment the record is created, so the
   * only way to prove the engine did not overwrite it with a false `0` on reading the headers
   * is to look during the transfer — and on loopback an unpaced few megabytes are gone before
   * the first poll lands.
   */
  chunks?: number;
  chunkDelayMs?: number;
}

export async function startFileHost(opts: FileHostOptions = {}): Promise<FileHost> {
  const mode = opts.mode ?? 'range';
  const body = opts.body ?? Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const filename = opts.filename ?? 'thing.bin';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const common = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'accept-ranges': 'bytes',
    };

    if (mode === 'no-headers') return; // socket accepted, nothing ever written

    if (mode === 'chunked') {
      // Omitting content-length is what makes Node frame this as chunked; several writes so
      // the body genuinely arrives in more than one chunk.
      res.writeHead(200, common);
      const pieces = Math.max(1, opts.chunks ?? 2);
      const delay = Math.max(0, opts.chunkDelayMs ?? 0);
      const per = Math.ceil(body.length / pieces);
      let sent = 0;
      const writeNext = (): void => {
        // The pause outlives nothing: `close()` destroys the socket under a paced response, so
        // a timer that fires afterwards must not write to a dead one.
        if (res.writableEnded || res.destroyed) return;
        const slice = body.subarray(sent, Math.min(sent + per, body.length));
        sent += slice.length;
        if (sent >= body.length) { res.end(slice); return; }
        res.write(slice);
        if (delay === 0) { writeNext(); return; }
        // `unref` so a half-written response can never be the reason the test runner stays up.
        setTimeout(writeNext, delay).unref?.();
      };
      writeNext();
      return;
    }

    let slice = body;
    let status = 200;
    const headers: Record<string, string> = { ...common };

    // An ordinary well-behaved file host. Nothing in the suite currently asks for a range —
    // Chromium's own resume is what would, and that path is driven against a fake session in
    // `test/unit/browser.test.ts` rather than over a socket — but a host that advertises
    // `accept-ranges` and then ignores one is not a plausible origin to test against.
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m) {
      const start = Number(m[1]);
      if (start >= body.length) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }); res.end(); return; }
      slice = body.subarray(start);
      status = 206;
      headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
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
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      for (const s of sockets) s.destroy();
    }),
  };
}
