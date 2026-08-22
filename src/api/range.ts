import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../log.js';

export interface ByteRange { start: number; end: number }

/**
 * Parse a `Range` header against a known size.
 *
 * Returns `null` for "serve the whole thing" — no header, an unknown unit, a multi-range
 * request, or garbage. A server is always permitted to ignore `Range`, and assembling a
 * `multipart/byteranges` body is surface this consumer does not need.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(.+)$/i.exec(header.trim());
  if (!m) return null;

  const spec = m[1]!.trim();
  if (spec.includes(',')) return null; // multi-range: ignore
  const dash = spec.indexOf('-');
  if (dash === -1) return null;

  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    if (!/^\d+$/.test(rawEnd)) return null;
    const n = Number(rawEnd);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  if (!/^\d+$/.test(rawStart)) return null;
  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';

  if (rawEnd === '') return { start, end: size - 1 };
  if (!/^\d+$/.test(rawEnd)) return null;
  const end = Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * RFC 6266 / RFC 5987. The name came from a remote server, so it is percent-encoded into the
 * `filename*` form — a raw CR or LF in a header value would be request smuggling.
 */
function contentDisposition(filename: string | null): string {
  if (!filename) return 'attachment';
  const safe = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename*=UTF-8''${safe}`;
}

const GENERIC_TYPE = 'application/octet-stream';

/** `type/subtype` in RFC 7231 token characters, with an optional parameter tail. */
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(\s*;.*)?$/;

/**
 * The content type came from the same remote response as the filename, so it is no more
 * trustworthy. A value that is not a plausible media type is replaced rather than
 * interpolated: a CR or LF in it would make `writeHead` throw, which — with nothing sent
 * yet — turns an untrusted header into a remote kill switch for the whole daemon.
 */
function mediaType(value: string | null): string {
  if (!value) return GENERIC_TYPE;
  const type = value.trim();
  if (type.length === 0 || type.length > 200) return GENERIC_TYPE;
  if (/[\r\n\0]/.test(type)) return GENERIC_TYPE;
  if (!MEDIA_TYPE.test(type)) return GENERIC_TYPE;
  return type;
}

/**
 * Open a read stream and settle only once the descriptor is really open, so an unreadable
 * file is known *before* a status line is committed.
 */
function openStream(path: string, start: number, end: number): Promise<ReadStream> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start, end });
    const done = (): void => { stream.off('open', onOpen); stream.off('error', onError); };
    const onOpen = (): void => { done(); resolve(stream); };
    const onError = (err: Error): void => { done(); stream.destroy(); reject(err); };
    stream.once('open', onOpen);
    stream.once('error', onError);
  });
}

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { path: string; size: number; contentType: string | null; filename: string | null },
): Promise<void> {
  const range = parseRange(req.headers.range, opts.size);

  if (range === 'unsatisfiable') {
    res.writeHead(416, {
      'content-range': `bytes */${opts.size}`,
      'accept-ranges': 'bytes',
      'content-length': '0',
    });
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, opts.size - 1);
  const length = opts.size === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    'content-type': mediaType(opts.contentType),
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(opts.filename),
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${opts.size}`;

  if (req.method === 'HEAD' || length === 0) {
    res.writeHead(range ? 206 : 200, headers);
    res.end();
    return;
  }

  // Open first: if the file is gone or unreadable, nothing has been committed yet and the
  // client can still be told the truth instead of being handed a truncated 200.
  let body: ReadStream;
  try {
    body = await openStream(opts.path, start, end);
  } catch (err) {
    log.warn('could not open a file to serve', { path: opts.path, error: String(err) });
    const payload = JSON.stringify({ error: 'file unavailable' });
    res.writeHead(500, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    });
    res.end(payload);
    return;
  }

  res.writeHead(range ? 206 : 200, headers);

  try {
    await pipeline(body, res);
  } catch (err) {
    // A client that cancels, seeks away, or times out mid-download makes `pipeline` reject
    // with ERR_STREAM_PREMATURE_CLOSE. That is routine, not an error, and it must never
    // escape: an unhandled rejection here would take the daemon down. The status line is
    // long gone, so there is nothing to say in band — drop the connection and move on.
    log.warn('download did not finish; the connection went away mid-stream', {
      path: opts.path,
      reason: String(err),
    });
    res.destroy();
  }
}
