import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { rm, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DownloadStore } from './store.js';
import type { FailureCode } from './record.js';
import { log } from '../log.js';

export interface TransferResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  abort(): void;
}

/**
 * The signal is a second parameter rather than a field of the request object so that an
 * implementation cannot quietly ignore it: it is part of the call, not part of the payload.
 * An implementation must abort the in-flight request and reject when it fires, or a cancel
 * that lands before the response headers do leaves the promise pending forever.
 */
export type Requester = (req: {
  url: string;
  headers: Record<string, string>;
  session: string;
}, signal: AbortSignal) => Promise<TransferResponse>;

/** Persisting progress means an fsync, so only report every few megabytes. */
export const PROGRESS_BYTES = 4 * 1024 * 1024;

function coded(code: FailureCode, message: string): { code: FailureCode; message: string } {
  return { code, message };
}

/**
 * A thrown value into a `FailureCode`. Running out of disk halfway through a large file is
 * the one local fault worth naming — everything unrecognised is a network fault, matching
 * the convention the job queue already uses.
 */
function failureOf(e: unknown): { code: FailureCode; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  const errno = (e as { code?: unknown } | null)?.code;
  return coded(errno === 'ENOSPC' ? 'disk-full' : 'network', message);
}

/** RFC 6266, both the plain and the RFC 5987 forms. Metadata only — never a path. */
function suggestedNameFrom(headers: Record<string, string>, url: string): string | null {
  const cd = headers['content-disposition'];
  if (cd) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through */ } }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(cd) ?? /filename\s*=\s*([^;]+)/i.exec(cd);
    if (plain) return plain[1]!.trim();
  }
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch { return null; }
}

/**
 * `content-length`, or `NaN` when the server did not give a usable one.
 *
 * `Number('')` is `0`, not `NaN`, so a *missing* header parsed with `Number(h ?? '')` reads as
 * "the body is empty" and every chunked response is then recorded as a short read — a
 * permanent failure, because the retained partial is complete and the retry earns a 416. The
 * header has to be tested for existence and shape before it is believed.
 */
function declaredLength(headers: Record<string, string>): number {
  const raw = headers['content-length'];
  if (raw === undefined) return NaN;
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

/**
 * The first byte offset a `content-range` claims to be sending, or `null` if it does not say
 * anything we can read. `bytes <first>-<last>/<complete>`; only `<first>` matters here.
 */
function rangeStart(value: string | undefined): number | null {
  const m = /^\s*bytes\s+(\d+)\s*-/i.exec(value ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Resolves once the write stream has given the file descriptor back to the OS.
 *
 * `end(cb)` is not good enough, but not for the reason it looks like. That callback does not
 * ride on `'finish'` and it is not lost when the stream errors: measured on Node 24.14, an
 * errored stream calls it *with* the error, and a healthy one calls it **ahead** of `'finish'`
 * — at which point `out.closed` is still false. That is the real objection. It runs while the
 * descriptor is still open, so settling there would break the ordering every writer owes
 * `record.ts`. `'close'` is emitted on both the success and the error path
 * (autoClose is on by default), and it is emitted *after* the handle is gone, which is what
 * lets the caller rely on "the handle is gone" before it settles the record or unlinks the
 * partial.
 *
 * Nothing else enforces that ordering. It is tempting to assume Windows does — that an open
 * handle makes the `unlink` fail loudly — but libuv deletes with POSIX semantics, so the
 * unlink succeeds, the name vanishes at once, and the stream carries on writing to a file
 * nobody can see. Measured on Node 24 / Windows 11 26200. Getting this wrong is silent on
 * every platform, which is exactly why `record.ts` spells the invariant out.
 */
function released(out: WriteStream): Promise<void> {
  if (out.closed) return Promise.resolve();
  return new Promise<void>((resolve) => out.once('close', () => resolve()));
}

async function release(out: WriteStream): Promise<void> {
  if (!out.writableEnded && !out.destroyed) out.end();
  await released(out);
}

/** Wait for backpressure to clear, but give up if the stream dies while we wait. */
function drained(out: WriteStream): Promise<void> {
  // A stream that is already closed will emit neither event. Today the caller cannot reach
  // here in that state; the guard is what stops an unrelated edit making that a hang.
  if (out.closed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => { out.off('drain', done); out.off('close', done); resolve(); };
    out.once('drain', done);
    out.once('close', done);
  });
}

/**
 * Stream one download into `<id>.part`, then rename to `<id>.bin`.
 *
 * Resume: if a partial exists we ask for `bytes=N-`. Appending is allowed only when the server
 * both answers 206 **and** its `content-range` starts at exactly the byte we asked for. A 200
 * means it ignored us and is sending from zero; a 206 whose `content-range` is missing,
 * unreadable, or points somewhere else means it is not sending what we asked for either — and
 * proxies and CDNs do both. In every one of those cases the partial is discarded, because
 * appending would silently corrupt the file, and a corrupt multi-GB ISO is expensive to
 * discover. The status code alone is not evidence.
 *
 * Hashing happens in a final pass over the finished file rather than while streaming. Streaming
 * cannot carry a partial hash across a process restart, and one extra local read is cheaper
 * than a hash that is wrong after a resume.
 *
 * Never rejects: this is driven from a long-running daemon, and every outcome is recorded on
 * the record instead of thrown at a caller that may not be awaiting it.
 */
export async function transfer(
  id: string,
  store: DownloadStore,
  request: Requester,
  signal: AbortSignal,
  /** Injectable only so a test can watch the throttled update actually happen. */
  progressBytes: number = PROGRESS_BYTES,
): Promise<void> {
  const rec = store.get(id);
  if (!rec) return;

  const part = store.partPath(id);
  let have = 0;
  try { have = (await stat(part)).size; } catch { /* no partial */ }

  /** Cancel is the one outcome that drops the partial; every failure below keeps it. */
  const settleCancelled = async (received: number): Promise<void> => {
    await rm(part, { force: true });
    log.info('download cancelled', { id, received });
    await store.update(id, { state: 'cancelled', received, error: coded('cancelled', 'cancelled by the caller') });
  };

  const headers: Record<string, string> = {};
  if (have > 0) headers['range'] = `bytes=${have}-`;
  if (rec.referer) headers['referer'] = rec.referer;

  // Cancelled before we even dialled. Opening the socket only to tear it down would be
  // pointless work, and leaving the record `running` would leave it unreclaimable.
  if (signal.aborted) { await settleCancelled(have); return; }

  await store.update(id, { state: 'running' });

  let res: TransferResponse;
  try {
    res = await request({ url: rec.url, headers, session: rec.session }, signal);
  } catch (e: unknown) {
    // A cancel during the request phase surfaces here as a rejection, and it is a cancel, not
    // a network fault: recording it as `failed` would put it in front of the retry logic.
    if (signal.aborted) { await settleCancelled(have); return; }
    const error = failureOf(e);
    log.warn('download request failed', { id, ...error });
    await store.update(id, { state: 'failed', error });
    return;
  }

  const onAbort = (): void => res.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  // The signal may have fired while we were awaiting the request, in which case the listener
  // above was registered too late to ever run.
  if (signal.aborted) res.abort();

  /** Set only when the body was read to its end, so the `finally` knows not to tear it down. */
  let bodyDone = false;

  try {
    if (res.status < 200 || res.status >= 300) {
      log.warn('download rejected by the server', { id, status: res.status });
      await store.update(id, { state: 'failed', error: coded('http-error', `server answered ${res.status}`) });
      return;
    }

    // Append only against a 206 that says, in its own `content-range`, that it is sending from
    // the byte we asked for. Anything else — a 200, no `content-range`, or one starting
    // elsewhere — is a body we cannot append to, so the partial goes.
    const claimedStart = res.status === 206 ? rangeStart(res.headers['content-range']) : null;
    const appending = have > 0 && res.status === 206 && claimedStart === have;
    if (have > 0 && !appending) {
      log.info('server ignored the range request, restarting the download', {
        id, discarded: have, status: res.status, contentRange: res.headers['content-range'] ?? null,
      });
      await rm(part, { force: true });
      have = 0;
    }

    // NaN when the server did not declare a length — chunked responses do not — and `total`
    // then carries the -1 "unknown" sentinel, which suppresses the short-read check below.
    const declared = declaredLength(res.headers);
    const total = Number.isFinite(declared) && declared >= 0 ? have + declared : -1;
    await store.update(id, {
      size: total,
      received: have,
      contentType: res.headers['content-type'] ?? null,
      suggestedName: suggestedNameFrom(res.headers, rec.url),
    });

    const out = createWriteStream(part, { flags: appending ? 'a' : 'w' });
    // A write stream with no error listener throws its error at the process. Capture the
    // first one instead and let the code below decide what it means.
    let writeError: unknown = null;
    out.on('error', (e: unknown) => { writeError ??= e; });

    let received = have;
    let sinceReport = 0;
    let streamError: unknown = null;

    try {
      for await (const chunk of res.body) {
        if (signal.aborted || writeError !== null) break;
        if (!out.write(chunk)) await drained(out);
        if (writeError !== null) break;
        received += chunk.byteLength;
        sinceReport += chunk.byteLength;
        // Progress is persisted, so throttle it — a per-chunk manifest write on a 4GB file
        // would be tens of thousands of fsyncs.
        if (sinceReport >= progressBytes) { sinceReport = 0; await store.update(id, { received }); }
      }
      bodyDone = !signal.aborted && writeError === null;
    } catch (e: unknown) {
      streamError = e;
    } finally {
      // Everything after this point runs with the file closed. That is what makes the settles
      // below safe against a retention sweep, per the invariant in record.ts.
      await release(out);
    }

    if (signal.aborted) { await settleCancelled(received); return; }

    // The partial is deliberately KEPT on every failure below: a later attempt resumes from it.
    if (writeError !== null) {
      const error = failureOf(writeError);
      log.warn('download could not be written to disk', { id, ...error });
      await store.update(id, { state: 'failed', received, error });
      return;
    }

    if (streamError !== null) {
      const error = failureOf(streamError);
      log.warn('download stream failed', { id, received, ...error });
      await store.update(id, { state: 'failed', received, error });
      return;
    }

    if (total >= 0 && received !== total) {
      log.warn('download ended short', { id, received, expected: total });
      await store.update(id, { state: 'failed', received, error: coded('network', `expected ${total} bytes, received ${received}`) });
      return;
    }

    const sha256 = await hashFile(part);
    await rename(part, store.filePath(id));
    const now = store.nowMs();
    await store.update(id, {
      state: 'done', received, size: received, sha256,
      completedAt: now, lastAccessAt: now,
    });
  } catch (e: unknown) {
    // Anything the streaming block itself did not account for: a failed rename, a hash that
    // could not be read. The partial, if any, stays put.
    const error = failureOf(e);
    log.warn('download failed', { id, ...error });
    await store.update(id, { state: 'failed', error });
  } finally {
    signal.removeEventListener('abort', onAbort);
    // A body we stopped reading early still owns a socket. Reading one to its end does not,
    // and tearing that one down would evict a perfectly good keep-alive connection.
    if (!bodyDone) res.abort();
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Uint8Array);
  return h.digest('hex');
}

/**
 * A `Requester` over Node's own http/https. This is the TEST path — production uses Electron's
 * `net` on the site's partition, which carries that partition's cookies and Chrome's TLS
 * fingerprint. Keeping both behind one narrow interface is what lets the transfer logic be
 * tested without a browser.
 */
export const nodeRequester: Requester = async ({ url, headers }, signal) => {
  // `addEventListener` on a signal that has already fired never calls back, so an early cancel
  // has to be caught here or it is not caught at all.
  if (signal.aborted) throw new Error('cancelled before the request was issued');
  const mod = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<TransferResponse>((resolve, reject) => {
    let answered = false;
    const req = mod(url, { headers }, (res) => {
      answered = true;
      signal.removeEventListener('abort', onAbort);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      resolve({ status: res.statusCode ?? 0, headers: flat, body: res, abort: () => req.destroy() });
    });
    // A server that accepts the socket and then says nothing holds this promise open for as
    // long as it likes. Nothing else is listening to the signal yet — the transfer only wires
    // it to the *response* — so without this a request-phase cancel is an unsettled promise
    // and a `running` record that no sweep may reclaim. `destroy()` takes no error argument on
    // purpose: it matches `abort()` above, and an error passed here would be re-emitted on a
    // response nobody is reading.
    const onAbort = (): void => { req.destroy(); if (!answered) reject(new Error('cancelled before the response arrived')); };
    signal.addEventListener('abort', onAbort, { once: true });
    // Once the response is in the caller's hands, a socket fault surfaces on the body stream
    // instead; this promise is already settled and a second call would be a no-op, so guard
    // it explicitly rather than leaving the intent to chance.
    req.on('error', (e) => { if (!answered) reject(e); });
    req.end();
  });
};
