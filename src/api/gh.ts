import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import type { DownloadStore } from '../downloads/store.js';
import { isSettled } from '../downloads/record.js';
import { serveFile } from './range.js';
import { validateTarget, isTargetError } from './target.js';
import { log } from '../log.js';

export interface GhDeps {
  store: DownloadStore;
  /** Hand the id to the download queue. */
  submit: (id: string) => void;
  /** Abort an in-flight download. */
  cancel: (id: string) => void;
  now: () => number;
}

type GhCode = 'bad-request' | 'not-found' | 'not-ready' | 'internal';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * How much of an over-long body we will read and throw away after answering, purely so the
 * close is an orderly one. A courtesy, not an obligation — nothing is buffered. Its own
 * constant rather than an import from `server.ts`, which imports this module.
 */
const MAX_DRAIN_BYTES = 8_000_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** `/gh/*` uses OUR error shape. `/v1` keeps FlareSolverr's — they are different contracts. */
function sendError(res: ServerResponse, status: number, code: GhCode, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/**
 * Resolves rather than rejects — this is awaited from a handler whose call site is `void`ed,
 * and an unhandled rejection takes a daemon down. `tooLarge` is distinguished from `unreadable`
 * because only the first has a client still pushing bytes at us that has to be dealt with.
 */
type Body = { ok: true; text: string } | { ok: false; tooLarge: boolean };

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { settled = true; resolve({ ok: false, tooLarge: true }); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }); } });
    req.on('error', () => { if (!settled) { settled = true; resolve({ ok: false, tooLarge: false }); } });
  });
}

/**
 * Answer first, hang up second — the same shape `/v1` uses in `server.ts`, and for the same
 * measured reason. Resolving the read stops us buffering, but it does not stop the client, and
 * ending the response while unread inbound data is still arriving makes the OS send RST rather
 * than FIN. An RST discards whatever of our reply is still in the client's receive buffer, so
 * it observes ECONNRESET instead of the 400 we just wrote.
 *
 * So: pause, write the reply, then drain a bounded remainder so the close is a FIN. Only a
 * client that keeps pushing past that gets cut off, and by then it has long since had its 400.
 * `setImmediate` rather than a same-tick destroy because `finish` means "handed to the socket",
 * not "transmitted", and an RST discards the sender's unflushed buffer too.
 *
 * Call this BEFORE sending, so the pause and the `finish` listener are both in place.
 */
function drainAfterAnswering(req: IncomingMessage, res: ServerResponse): void {
  req.pause();
  res.on('finish', () => {
    let drained = 0;
    req.on('data', (c: Buffer) => {
      drained += c.length;
      if (drained > MAX_DRAIN_BYTES) setImmediate(() => req.destroy());
    });
    req.resume();
  });
}

/**
 * Handle a `/gh/*` request. Returns false when `path` is not one of ours, so the caller's
 * router can fall through to its own 404.
 */
export async function handleGh(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: GhDeps,
): Promise<boolean> {
  if (path === '/gh/fetch') {
    if (req.method !== 'POST') { sendError(res, 405, 'bad-request', 'POST only'); return true; }
    await postFetch(req, res, deps);
    return true;
  }

  const job = /^\/gh\/jobs\/([^/]+)$/.exec(path);
  if (job) {
    // decodeURIComponent so an encoded traversal attempt is compared as the literal it is; the
    // id is only ever a MAP KEY, never joined into a path, so a miss is simply 404.
    const id = safeDecode(job[1]!);
    if (req.method === 'GET') { getJob(res, id, deps); return true; }
    if (req.method === 'DELETE') { await deleteJob(res, id, deps); return true; }
    sendError(res, 405, 'bad-request', 'GET or DELETE only');
    return true;
  }

  const file = /^\/gh\/files\/([^/]+)$/.exec(path);
  if (file) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendError(res, 405, 'bad-request', 'GET or HEAD only'); return true; }
    await getFile(req, res, safeDecode(file[1]!), deps);
    return true;
  }

  return false;
}

/** `decodeURIComponent` throws on a lone `%`; a malformed escape is simply not an id. */
function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

async function postFetch(req: IncomingMessage, res: ServerResponse, deps: GhDeps): Promise<void> {
  const read = await readBody(req);
  if (!read.ok) {
    if (read.tooLarge) drainAfterAnswering(req, res);
    sendError(res, 400, 'bad-request', 'request body was unreadable or too large');
    return;
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(read.text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'bad-request', 'request body must be a JSON object');
    return;
  }

  // The same gate `/v1` applies, from the same module: two copies of a security check drift.
  const target = validateTarget(body.url, body.site);
  if (isTargetError(target)) { sendError(res, 400, 'bad-request', target.message); return; }

  const open = deps.store.findOpen(target.session, target.url);
  if (open) { sendJson(res, 202, { jobId: open.id, state: open.state }); return; }

  // The one caller-supplied field we hand to a THIRD party: the engine sends it as an outbound
  // `Referer`. Node's own validator would throw rather than let a CRLF split the request, but
  // that throw is a fault we would rather not manufacture — and the value is persisted into a
  // manifest that is rewritten in full on every progress tick, so an oversized one is
  // amplified across the whole download. Accept only a plain http(s) URL.
  let referer: string | null = null;
  if (typeof body.referer === 'string' && body.referer !== '') {
    let parsedReferer: URL | null = null;
    try { parsedReferer = new URL(body.referer); } catch { parsedReferer = null; }
    if (!parsedReferer || (parsedReferer.protocol !== 'http:' && parsedReferer.protocol !== 'https:')) {
      sendError(res, 400, 'bad-request', 'referer must be an http or https URL');
      return;
    }
    referer = parsedReferer.href;
  }

  // Nothing open for this target, so this is a NEW record with a new id — there is deliberately
  // no reclaim of a settled `failed` one.
  //
  // There used to be. It existed so a 40GB download would not restart from zero after a blip,
  // and under the byte-stream transfer that was real. Under the browser engine it has no
  // reachable trigger: a stall ends in `item.cancel()` and Chromium deletes the partial of an
  // item it cancelled; a natural mid-body interrupt never fires `done` at all, so it only ever
  // reaches us through that same stall path; and a 404 settles with 0 bytes and no file. The
  // one shape that did still match was pathological — a download that completed but could not
  // be hashed or renamed, whose COMPLETE `.part` then resumed at `offset === size`, took a 416,
  // interrupted, and went round again. A loop was the only reachable path through it.
  //
  // Mid-transfer resilience now comes from Chromium's own retry of a dropped ranged transfer.
  // Across a restart it comes from `requeueInterrupted`, which is a different mechanism and
  // still proven.
  const rec = await deps.store.create({ url: target.url, session: target.session, referer });
  deps.submit(rec.id);
  sendJson(res, 202, { jobId: rec.id, state: rec.state });
}

function getJob(res: ServerResponse, id: string, deps: GhDeps): void {
  const rec = deps.store.get(id);
  if (!rec) { sendError(res, 404, 'not-found', `no such job: ${id}`); return; }

  const body: Record<string, unknown> = {
    state: rec.state,
    progress: { received: rec.received, total: rec.size },
  };
  if (rec.state === 'done') {
    body.result = {
      path: deps.store.filePath(rec.id),
      url: `/gh/files/${rec.id}`,
      size: rec.size,
      sha256: rec.sha256,
      filename: rec.suggestedName,
      contentType: rec.contentType,
    };
  }
  if (rec.error) body.error = rec.error;
  sendJson(res, 200, body);
}

async function deleteJob(res: ServerResponse, id: string, deps: GhDeps): Promise<void> {
  const rec = deps.store.get(id);
  if (!rec) { sendError(res, 404, 'not-found', `no such job: ${id}`); return; }

  if (!isSettled(rec.state)) {
    // Cancelling is asynchronous: the engine notices the abort, cancels the browser's item,
    // and only marks the record cancelled once Chromium has released the file. Removing the
    // record here would race that writer — see the settle-after-close invariant in
    // `downloads/record.ts`.
    deps.cancel(id);
  } else {
    await deps.store.remove(id);
  }
  res.writeHead(204);
  res.end();
}

async function getFile(req: IncomingMessage, res: ServerResponse, id: string, deps: GhDeps): Promise<void> {
  // The lookup comes FIRST, and it is a map lookup. No path exists for an id we do not know,
  // so a traversal attempt never reaches the filesystem — it is just a missing key.
  const rec = deps.store.get(id);
  if (!rec) { sendError(res, 404, 'not-found', `no such job: ${id}`); return; }
  if (rec.state !== 'done') { sendError(res, 409, 'not-ready', `job ${id} is ${rec.state}`); return; }

  const path = deps.store.filePath(id);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (e: unknown) {
    // ENOENT really is "gone". Anything else — EACCES, EIO — is a fault on our side that
    // would otherwise present to an operator as a vanished file, so say so in the log.
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT') {
      log.error('could not read a completed download from disk', { id, path, reason: String(e) });
    }
    sendError(res, 404, 'not-found', `bytes for ${id} are gone`);
    return;
  }

  await deps.store.touch(id);
  await serveFile(req, res, { path, size, contentType: rec.contentType, filename: rec.suggestedName });
}
