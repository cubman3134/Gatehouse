import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

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

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { path: string; size: number; contentType: string | null; filename: string | null },
): Promise<void> {
  const range = parseRange(req.headers.range, opts.size);

  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${opts.size}`, 'accept-ranges': 'bytes' });
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, opts.size - 1);
  const length = opts.size === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/octet-stream',
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(opts.filename),
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${opts.size}`;

  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || length === 0) { res.end(); return; }

  await pipeline(createReadStream(opts.path, { start, end }), res);
}
