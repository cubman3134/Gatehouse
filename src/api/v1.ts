import { badSession, isTargetError, SESSION_NAME, validSession, validateTarget } from './target.js';

/**
 * Re-exported: the pattern moved to `target.ts` so `/gh/fetch` shares it, but `/v1` is the
 * surface that has always published it and importers must not have to chase the move.
 */
export { SESSION_NAME };

export interface SolvedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface Solution {
  url: string;
  status: number;
  headers: Record<string, string>;
  cookies: SolvedCookie[];
  userAgent: string;
  response: string;
}

/** The two /v1 commands that reach the browser. */
export type SolveCommand = 'request.get' | 'request.post';

export interface SolveRequest {
  /**
   * Carried through because a solve is not identified by its URL alone: a `request.post`
   * with no body and a `request.get` to the same URL are different navigations, and without
   * this the queue's dedupe key collapses them onto one job.
   */
  cmd: SolveCommand;
  url: string;
  session: string;
  maxTimeout: number;
  postData?: string;
}

export type Solver = (req: SolveRequest) => Promise<Solution>;

export interface V1Deps {
  solve: Solver;
  now: () => number;
  version: string;
  /** Session names created via sessions.create. Partitions are created lazily regardless. */
  sessions: Set<string>;
  /**
   * Tear down everything a session name owns — the pooled window and the partition on disk.
   * Optional: without it `sessions.destroy` only forgets the name, which is what the pure
   * unit tests exercise. Wired in `main.ts`, where Electron is actually available.
   */
  destroySession?: (name: string) => Promise<void>;
}

const DEFAULT_MAX_TIMEOUT = 60_000;
const MAX_MAX_TIMEOUT = 300_000;
function ok(deps: V1Deps, startTimestamp: number, extra: Record<string, unknown>) {
  return {
    httpStatus: 200,
    body: {
      status: 'ok',
      message: '',
      startTimestamp,
      endTimestamp: deps.now(),
      version: deps.version,
      ...extra,
    },
  };
}

/** Exported so the HTTP layer's own error replies are built here rather than hand-rolled. */
export function fail(deps: V1Deps, startTimestamp: number, message: string) {
  return {
    httpStatus: 500,
    body: {
      status: 'error',
      message,
      startTimestamp,
      endTimestamp: deps.now(),
      version: deps.version,
    },
  };
}

/**
 * FlareSolverr's /v1 protocol. The shape here is not ours to design — Allarr already speaks
 * it, and matching it exactly is what lets this ship without touching Allarr.
 *
 * Allarr reads precisely two things: `solution.userAgent`, and the `cf_clearance` entry in
 * `solution.cookies`. Everything else exists for compatibility with other callers.
 */
export async function handleV1(body: unknown, deps: V1Deps): Promise<{ httpStatus: number; body: unknown }> {
  const startTimestamp = deps.now();

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(deps, startTimestamp, 'request body must be a JSON object');
  }

  const req = body as Record<string, unknown>;
  const cmd = typeof req.cmd === 'string' ? req.cmd : '';

  switch (cmd) {
    case 'sessions.create': {
      const supplied = typeof req.session === 'string' && req.session ? req.session : '';
      if (supplied && !validSession(supplied)) {
        return fail(deps, startTimestamp, badSession(supplied));
      }
      const session = supplied || 'default';
      deps.sessions.add(session);
      return ok(deps, startTimestamp, { session });
    }
    case 'sessions.list':
      return ok(deps, startTimestamp, { sessions: [...deps.sessions] });
    case 'sessions.destroy': {
      const session = typeof req.session === 'string' ? req.session : '';
      if (session && !validSession(session)) {
        return fail(deps, startTimestamp, badSession(session));
      }
      deps.sessions.delete(session);
      // Forgetting the name is not destroying the session: the `persist:` partition, its
      // cookies on disk and the pooled idle window all outlive it, so the next solve on that
      // name would resume with the very cf_clearance the caller asked to be rid of. An empty
      // name is not a session — `persist:` is not a partition — so nothing is torn down for
      // it, which matches the pre-existing behaviour of answering ok.
      if (deps.destroySession && session) {
        try {
          await deps.destroySession(session);
        } catch (e: unknown) {
          return fail(deps, startTimestamp, e instanceof Error ? e.message : String(e));
        }
      }
      return ok(deps, startTimestamp, {});
    }
    case 'request.get':
    case 'request.post': {
      // The same gate `/gh/fetch` uses: the scheme allow-list, and reject-vs-sanitize on the
      // session name. Only the rendering of a rejection differs — /v1 must answer 500 with
      // FlareSolverr's error shape, never a 400, because that is the signal its clients read.
      const target = validateTarget(req.url, req.session);
      if (isTargetError(target)) return fail(deps, startTimestamp, target.message);

      const requested =
        typeof req.maxTimeout === 'number' && Number.isFinite(req.maxTimeout) && req.maxTimeout > 0
          ? req.maxTimeout
          : DEFAULT_MAX_TIMEOUT;
      const maxTimeout = Math.min(requested, MAX_MAX_TIMEOUT);
      const postData = cmd === 'request.post' && typeof req.postData === 'string' ? req.postData : undefined;

      try {
        // `target.url` is the PARSED href, not the raw string. The allow-list decision was
        // made on the parse, so handing the browser anything else leaves a gap between what
        // we inspected and what gets fetched. Node and Chromium both implement WHATWG
        // parsing, so no divergence is known — this closes the class rather than a case.
        const solution = await deps.solve({ cmd, url: target.url, session: target.session, maxTimeout, postData });
        return ok(deps, startTimestamp, { solution });
      } catch (e: unknown) {
        return fail(deps, startTimestamp, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return fail(deps, startTimestamp, `unknown command: ${cmd || '(none)'}`);
  }
}
