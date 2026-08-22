import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import type { DownloadStore } from '../downloads/store.js';
import { isSettled } from '../downloads/record.js';
import { serveFile } from './range.js';
import { validateTarget, isTargetError } from './target.js';

export interface GhDeps {
  store: DownloadStore;
  /** Hand the id to the download queue. */
  submit: (id: string) => void;
  /** Abort an in-flight transfer. */
  cancel: (id: string) => void;
  now: () => number;
}

type GhCode = 'bad-request' | 'not-found' | 'not-ready' | 'internal';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** `/gh/*` uses OUR error shape. `/v1` keeps FlareSolverr's — they are different contracts. */
function sendError(res: ServerResponse, status: number, code: GhCode, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { settled = true; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    // Resolves rather than rejects: this promise is awaited from a handler whose call site is
    // `void`ed, and an unhandled rejection takes a daemon down. `null` is "unreadable".
    req.on('error', () => { if (!settled) { settled = true; resolve(null); } });
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
  const raw = await readBody(req);
  if (raw === null) { sendError(res, 400, 'bad-request', 'request body was unreadable or too large'); return; }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
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

  const referer = typeof body.referer === 'string' ? body.referer : null;
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
    // Cancelling is asynchronous: the transfer notices the abort, closes its stream, deletes
    // its partial, and only then marks the record cancelled. Removing the record here would
    // race that writer — see the settle-after-close invariant in `downloads/record.ts`.
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
  try { size = (await stat(path)).size; } catch { sendError(res, 404, 'not-found', `bytes for ${id} are gone`); return; }

  await deps.store.touch(id);
  await serveFile(req, res, { path, size, contentType: rec.contentType, filename: rec.suggestedName });
}
