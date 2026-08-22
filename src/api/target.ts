/**
 * What may we point a browser at, and under what partition name.
 *
 * This lives in its own module rather than inside `v1.ts` because `/gh/fetch` needs exactly
 * the same answer, and two copies of a security check drift. Both surfaces call
 * `validateTarget`; only the shape of the rejection they render differs.
 */

const MAX_SESSION_LENGTH = 64;

/**
 * A session name becomes a Chromium partition (`persist:<session>`) and from there a
 * directory on disk, so it is restricted to characters that cannot walk out of it.
 */
export const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** `.` and `..` clear the charset but are filesystem specials, not names. */
function allDots(value: string): boolean {
  return /^\.+$/.test(value);
}

/** A caller-supplied session is accepted verbatim or not at all. */
export function validSession(value: string): boolean {
  return SESSION_NAME.test(value) && !allDots(value);
}

/** The value is echoed because the caller sent it; it is a partition label, not a secret. */
export function badSession(value: string): string {
  return `session must match ${SESSION_NAME.source} and not be all dots: ${value}`;
}

/**
 * A derived session is sanitized rather than rejected — the caller did not choose it, and
 * hosts legitimately carry characters a path cannot (an IPv6 literal arrives as `[::1]`).
 */
function sanitizeSession(host: string): string {
  const cleaned = host.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, MAX_SESSION_LENGTH);
  return !cleaned || allDots(cleaned) ? 'default' : cleaned;
}

export interface TargetError { message: string }

export function isTargetError(x: unknown): x is TargetError {
  return typeof x === 'object' && x !== null && 'message' in x && !('url' in x);
}

/**
 * The single gate for "what may we point a browser at, and under what partition name".
 *
 * A caller-supplied session is REJECTED when malformed; a derived one is SANITIZED — the
 * caller can fix their own input, but a hostname is not theirs to fix.
 *
 * The returned `url` is the PARSED href, not the raw string. The scheme decision was made on
 * the parse, so handing anything else onward would leave a gap between what was inspected and
 * what gets fetched.
 */
export function validateTarget(rawUrl: unknown, rawSession: unknown): { url: string; session: string } | TargetError {
  if (typeof rawUrl !== 'string' || rawUrl === '') return { message: 'url is required and must be a string' };

  // The URL is handed to a real browser. Without a scheme allow-list, `file:` turns this into
  // an arbitrary local-file reader that answers over the wire.
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return { message: `url is not a valid URL: ${rawUrl}` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { message: `url scheme ${parsed.protocol} is not supported; only http and https are` };
  }

  const supplied = typeof rawSession === 'string' && rawSession ? rawSession : '';
  if (supplied && !validSession(supplied)) return { message: badSession(supplied) };

  // `mailto:`, `data:`, `about:` and friends parse cleanly with no host at all — they are
  // already refused above, but the fallback stays so this function is total on its own terms.
  return { url: parsed.href, session: supplied || (parsed.hostname ? sanitizeSession(parsed.hostname) : 'default') };
}
