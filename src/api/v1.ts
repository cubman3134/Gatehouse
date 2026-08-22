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
function validSession(value: string): boolean {
  return SESSION_NAME.test(value) && !allDots(value);
}

/** The value is echoed because the caller sent it; it is a partition label, not a secret. */
function badSession(value: string): string {
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

/** Session name derived from a URL when the caller supplies none. */
function sessionFor(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 'default';
  }
  // `mailto:`, `data:`, `about:` and friends parse cleanly with no host at all.
  return hostname ? sanitizeSession(hostname) : 'default';
}

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
      const url = typeof req.url === 'string' ? req.url : '';
      if (!url) return fail(deps, startTimestamp, 'url is required for ' + cmd);

      // The URL is handed to a real browser. Without a scheme allow-list, `file:` turns this
      // into an arbitrary local-file reader that answers over the wire.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail(deps, startTimestamp, `url is not a valid URL: ${url}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail(
          deps,
          startTimestamp,
          `url scheme ${parsed.protocol} is not supported; only http and https are`,
        );
      }

      const suppliedSession = typeof req.session === 'string' && req.session ? req.session : '';
      if (suppliedSession && !validSession(suppliedSession)) {
        return fail(deps, startTimestamp, badSession(suppliedSession));
      }

      const requested =
        typeof req.maxTimeout === 'number' && Number.isFinite(req.maxTimeout) && req.maxTimeout > 0
          ? req.maxTimeout
          : DEFAULT_MAX_TIMEOUT;
      const maxTimeout = Math.min(requested, MAX_MAX_TIMEOUT);
      const session = suppliedSession || sessionFor(url);
      const postData = cmd === 'request.post' && typeof req.postData === 'string' ? req.postData : undefined;

      try {
        // Forward the PARSED href, not the raw string. The allow-list decision was made on
        // `parsed`, so handing the browser anything else leaves a gap between what we
        // inspected and what gets fetched. Node and Chromium both implement WHATWG parsing,
        // so no divergence is known — this closes the class rather than a specific case.
        const solution = await deps.solve({ cmd, url: parsed.href, session, maxTimeout, postData });
        return ok(deps, startTimestamp, { solution });
      } catch (e: unknown) {
        return fail(deps, startTimestamp, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return fail(deps, startTimestamp, `unknown command: ${cmd || '(none)'}`);
  }
}
