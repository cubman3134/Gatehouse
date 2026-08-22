import { createReadStream } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { validateHeaderValue } from 'node:http';
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

/** A surrogate code unit with no partner — half of a character, and not encodable as UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * RFC 6266 / RFC 5987. The name came from a remote server, so it is percent-encoded into the
 * `filename*` form — a raw CR or LF in a header value would be request smuggling.
 *
 * This must be total. `encodeURIComponent` throws `URIError: URI malformed` on a lone
 * surrogate, and an upstream filename carries one the moment a name is truncated mid-character
 * — so an unguarded encode is a remote kill switch of exactly the kind this module exists to
 * close. Unpaired surrogates are replaced first, and the encode is wrapped anyway.
 */
function contentDisposition(filename: string | null): string {
  if (!filename) return 'attachment';
  const paired = filename.replace(LONE_SURROGATE, '�');
  try {
    const safe = encodeURIComponent(paired).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename*=UTF-8''${safe}`;
  } catch (err) {
    log.warn('could not encode a suggested filename; sending a bare attachment disposition', {
      reason: String(err),
    });
    return 'attachment';
  }
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
 * What a header falls back to when Node refuses the value we built. A header named here is
 * replaced; one that is not is dropped. Both fallbacks are constants, so neither can fail.
 */
const HEADER_FALLBACKS: Record<string, string> = {
  'content-type': GENERIC_TYPE,
  'content-disposition': 'attachment',
};

/**
 * The backstop. Node runs its own validator over every outgoing header value and throws
 * `ERR_INVALID_CHAR` on a strictly larger set than any shape check here rejects: every C0
 * control bar HT/LF/CR/NUL, DEL, and *every* codepoint above Latin-1. A `content-type`
 * parameter carrying `€`, a CJK title, or a stray `\x01` is enough — and none of that is
 * exotic in a filename an upstream server chose.
 *
 * That throw would land inside `writeHead`, after the descriptor is open: an unhandled
 * rejection and an abandoned fd, from a header a remote server picked. Hand-rolled blacklists
 * have been wrong twice about which characters those are, so this asks the only authority that
 * matters — the same predicate `writeHead` is about to apply — and substitutes anything it
 * refuses. Nothing reaches `writeHead` that Node has not already accepted.
 */
function vetHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    try {
      validateHeaderValue(name, value);
      out[name] = value;
    } catch (err) {
      const fallback = HEADER_FALLBACKS[name];
      log.warn('an outgoing header value was not one Node will send; substituting', {
        header: name,
        reason: String(err),
        substituted: fallback ?? '(header dropped)',
      });
      if (fallback !== undefined) out[name] = fallback;
    }
  }
  return out;
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
    res.writeHead(416, vetHeaders({
      'content-range': `bytes */${opts.size}`,
      'accept-ranges': 'bytes',
      'content-length': '0',
    }));
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
    res.writeHead(range ? 206 : 200, vetHeaders(headers));
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
    res.writeHead(500, vetHeaders({
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
    }));
    res.end(payload);
    return;
  }

  // The client may already be gone: a reset that lands while `fs.open` was in flight leaves a
  // descriptor with nowhere to send it. `pipeline` rejects ERR_STREAM_UNABLE_TO_PIPE *before*
  // it takes ownership of the source, so it never closes the stream for us — one leaked fd per
  // abort, and the window is open-latency, which is widest on exactly the contended disks and
  // network shares a download gateway serves from.
  if (res.destroyed) {
    body.destroy();
    return;
  }

  // The stream is open, so ANY throw from here leaks a descriptor and escapes into a `void
  // serveFile(...)` call site. `vetHeaders` guarantees the VALUES are sendable, but writeHead
  // also validates header NAMES, and this module's thesis is not to depend on a list staying
  // correct — including the list of names a future contributor might make dynamic.
  try {
    res.writeHead(range ? 206 : 200, vetHeaders(headers));
  } catch (err) {
    body.destroy();
    res.destroy();
    log.error('could not send response headers', { path: opts.path, reason: String(err) });
    return;
  }

  try {
    await pipeline(body, res);
  } catch (err) {
    // Nothing here may escape: an unhandled rejection would take the daemon down. The status
    // line is long gone, so there is nothing to say in band — close both ends and move on.
    // `body` is destroyed explicitly because a rejection that predates `pipeline` taking
    // ownership leaves the source untouched.
    body.destroy();
    res.destroy();

    // Two very different events reach this catch, and conflating them makes this log line lie
    // at 3am. A client that cancels, seeks away, or times out gives ERR_STREAM_PREMATURE_CLOSE
    // and is routine. Anything else — a truncated file, a revoked permission, a disk error
    // mid-transfer — is our fault, and must not be filed as a client hang-up.
    if ((err as NodeJS.ErrnoException | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      log.warn('download did not finish; the connection went away mid-stream', {
        path: opts.path,
        reason: String(err),
      });
    } else {
      log.error('download failed after the response had started', {
        path: opts.path,
        reason: String(err),
      });
    }
  }
}
