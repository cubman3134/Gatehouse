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

export interface SolveRequest {
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
}

const DEFAULT_MAX_TIMEOUT = 60_000;

/** Session name derived from a URL when the caller supplies none. */
function sessionFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'default';
  }
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

function fail(deps: V1Deps, startTimestamp: number, message: string) {
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
      const session = typeof req.session === 'string' && req.session ? req.session : 'default';
      deps.sessions.add(session);
      return ok(deps, startTimestamp, { session });
    }
    case 'sessions.list':
      return ok(deps, startTimestamp, { sessions: [...deps.sessions] });
    case 'sessions.destroy': {
      const session = typeof req.session === 'string' ? req.session : '';
      deps.sessions.delete(session);
      return ok(deps, startTimestamp, {});
    }
    case 'request.get':
    case 'request.post': {
      const url = typeof req.url === 'string' ? req.url : '';
      if (!url) return fail(deps, startTimestamp, 'url is required for ' + cmd);

      const maxTimeout =
        typeof req.maxTimeout === 'number' && Number.isFinite(req.maxTimeout) && req.maxTimeout > 0
          ? req.maxTimeout
          : DEFAULT_MAX_TIMEOUT;
      const session = typeof req.session === 'string' && req.session ? req.session : sessionFor(url);
      const postData = cmd === 'request.post' && typeof req.postData === 'string' ? req.postData : undefined;

      try {
        const solution = await deps.solve({ url, session, maxTimeout, postData });
        return ok(deps, startTimestamp, { solution });
      } catch (e: unknown) {
        return fail(deps, startTimestamp, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return fail(deps, startTimestamp, `unknown command: ${cmd || '(none)'}`);
  }
}
