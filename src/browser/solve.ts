import type { BrowserPool } from './pool.js';
import { classify, type PageSnapshot } from './detect.js';
import type { Solution, Solver, SolveRequest, SolvedCookie } from '../api/v1.js';
import type { FailureCode } from '../jobs/queue.js';
import { log } from '../log.js';

const POLL_INTERVAL_MS = 400;

/** A fixed literal. Page content is never interpolated into this. */
const GRAB_HTML = 'document.documentElement.outerHTML';

function coded(code: FailureCode, message: string, cause?: unknown): Error {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause });
  return Object.assign(err, { code });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Main-frame response status and headers for one webContents, as they arrive. */
interface FrameState {
  status: number;
  headers: Record<string, string>;
}

/**
 * One `onHeadersReceived` registration per Electron Session, shared by every solve running on
 * that session's partition.
 *
 * `onHeadersReceived` is a setter, not an emitter: a second call replaces the first, and
 * `(null)` clears the slot outright. Two concurrent solves on one session name run in two
 * different BrowserWindows but on the *same* `persist:<name>` partition, hence the same
 * Session — so a per-solve registration silently evicts its neighbour's, leaving that solve
 * with `status: 0` and no headers for its whole run. Losing the headers loses the
 * `cf-mitigated: challenge` signal, which is how an interstitial gets misjudged `clear` and
 * returned to the caller as content. That is a fail-open, so the listener is refcounted here
 * and demultiplexed on `details.webContentsId` instead.
 */
interface SessionHook {
  refs: number;
  byWebContents: Map<number, FrameState>;
}

const hooks = new Map<Electron.Session, SessionHook>();

function normalizeHeaders(raw: Record<string, string[]> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw ?? {}).map(([k, v]) => [
      k.toLowerCase(),
      Array.isArray(v) ? v.join(', ') : String(v),
    ]),
  );
}

/**
 * Claim a slot on this session's shared listener, registering the listener if this is the
 * first solve on it. Returns the state record this solve — and only this solve — reads.
 */
function attach(ses: Electron.Session, webContentsId: number): FrameState {
  let hook = hooks.get(ses);
  if (hook === undefined) {
    const created: SessionHook = { refs: 0, byWebContents: new Map() };
    hooks.set(ses, created);
    ses.webRequest.onHeadersReceived((details, cb) => {
      if (details.resourceType === 'mainFrame' && details.webContentsId !== undefined) {
        const state = created.byWebContents.get(details.webContentsId);
        if (state !== undefined) {
          state.status = details.statusCode;
          state.headers = normalizeHeaders(details.responseHeaders);
        }
      }
      cb({});
    });
    hook = created;
  }

  hook.refs++;
  const state: FrameState = { status: 0, headers: {} };
  hook.byWebContents.set(webContentsId, state);
  return state;
}

/**
 * Release this solve's slot. The listener is torn down only when the last solve on the
 * session leaves, so an interleaved A-in, B-in, A-out, B-out keeps B's listener live.
 */
function detach(ses: Electron.Session, webContentsId: number): void {
  const hook = hooks.get(ses);
  if (hook === undefined) return;

  hook.byWebContents.delete(webContentsId);
  hook.refs = Math.max(0, hook.refs - 1);
  if (hook.refs === 0) {
    hooks.delete(ses);
    ses.webRequest.onHeadersReceived(null);
  }
}

/**
 * Bound one awaited step by the solve deadline. Without this a host that accepts the
 * connection and then stalls holds `loadURL` open indefinitely, pinning a pool window and a
 * queue slot — two such hosts wedge the whole service at the default concurrency of 2.
 */
function withDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(coded('network', message)), Math.max(0, deadline - Date.now()));
  });
  // When the guard wins, `work` keeps running and may reject later (an aborted navigation
  // does exactly that). Give it a handler now so that rejection is not unhandled.
  work.catch(() => { /* the race already reported the outcome */ });
  return Promise.race([work, guard]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export function makeSolver(pool: BrowserPool): Solver {
  return async (req: SolveRequest): Promise<Solution> => {
    const win = await pool.acquire(req.session);
    // Everything after the acquire runs inside the try: a throw while reading `webContents`
    // or `session` must still hit `pool.release`, or `busy` inflates permanently.
    try {
      const wc = win.webContents;
      const ses = wc.session;
      const frame = attach(ses, wc.id);

      try {
        const deadline = Date.now() + req.maxTimeout;

        const navigation = req.postData !== undefined
          ? wc.loadURL(req.url, {
              postData: [{ type: 'rawData', bytes: Buffer.from(req.postData, 'utf8') }],
              extraHeaders: 'Content-Type: application/x-www-form-urlencoded',
            })
          : wc.loadURL(req.url);

        try {
          await withDeadline(
            navigation,
            deadline,
            `loading ${req.url} did not complete within ${req.maxTimeout}ms`,
          );
        } catch (e: unknown) {
          // Abort the pending navigation so the window goes back to the pool idle rather
          // than still fetching from a host that never answers.
          if (!wc.isDestroyed()) wc.stop();
          throw e;
        }

        let verdict = 'challenged' as ReturnType<typeof classify>;
        let html = '';

        while (Date.now() < deadline) {
          html = (await withDeadline(
            // `false` is userGesture: reading the DOM needs no gesture privileges, and
            // granting them hands gesture-gated APIs to whatever the host served.
            wc.executeJavaScript(GRAB_HTML, false) as Promise<string>,
            deadline,
            `reading ${req.url} did not complete within ${req.maxTimeout}ms`,
          ));
          const snap: PageSnapshot = { status: frame.status, headers: frame.headers, html };
          verdict = classify(snap);

          if (verdict === 'clear') break;
          if (verdict === 'blocked') {
            throw coded('blocked', `host returned a hard block for ${req.url}`);
          }
          if (verdict === 'interactive') {
            // SEAM FOR INCREMENT 3: this is where the job becomes `pending-human` and the
            // window is shown. Until then an interactive challenge is a clean failure.
            throw coded(
              'challenge-failed',
              `${req.url} needs an interactive challenge solved; not supported yet`,
            );
          }
          // Never sleep past the deadline: a full interval of overrun is a full interval the
          // caller waits for an answer already known to be late.
          await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
        }

        if (verdict !== 'clear') {
          throw coded('challenge-failed', `challenge did not clear within ${req.maxTimeout}ms for ${req.url}`);
        }

        const finalUrl = wc.getURL();
        const raw = await ses.cookies.get({ url: finalUrl });
        const cookies: SolvedCookie[] = raw.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain ?? '',
          path: c.path ?? '/',
          expires: c.expirationDate ?? -1,
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? false,
        }));

        log.info('solved', {
          url: req.url,
          session: req.session,
          status: frame.status,
          cookies: cookies.length,
        });

        return {
          url: finalUrl,
          status: frame.status,
          headers: frame.headers,
          cookies,
          userAgent: wc.getUserAgent(),
          response: html,
        };
      } catch (e: unknown) {
        if (wc.isDestroyed()) {
          const detail = e instanceof Error ? e.message : String(e);
          throw coded('browser-crashed', `the browser window died mid-solve: ${detail}`, e);
        }
        throw e;
      } finally {
        detach(ses, wc.id);
      }
    } finally {
      pool.release(win);
    }
  };
}
