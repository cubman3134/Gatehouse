export class ConfigError extends Error {}

export interface GatehouseConfig {
  port: number;
  bind: string;
  token: string | null;
  concurrency: number;
  solveTimeoutMs: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** True for a bind address that only the local machine can reach. */
export function isLoopback(bind: string): boolean {
  return LOOPBACK.has(bind);
}

function intFrom(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): GatehouseConfig {
  const bind = env.GATEHOUSE_BIND?.trim() || '127.0.0.1';
  const rawToken = env.GATEHOUSE_TOKEN?.trim();
  const token = rawToken ? rawToken : null;

  // Allarr's FlareSolverr client sends no Authorization header, so a loopback bind must not
  // require one. Anything reachable off-box must, and we refuse to start rather than silently
  // exposing a browser driver to the network.
  if (!isLoopback(bind) && token === null) {
    throw new ConfigError(
      `GATEHOUSE_BIND=${bind} is not loopback, so GATEHOUSE_TOKEN is required. ` +
        `Refusing to start an unauthenticated browser driver on a reachable address.`,
    );
  }

  return {
    bind,
    token,
    port: intFrom(env.GATEHOUSE_PORT, 8191, 'GATEHOUSE_PORT', 0, 65535),
    concurrency: intFrom(env.GATEHOUSE_CONCURRENCY, 2, 'GATEHOUSE_CONCURRENCY', 1, 16),
    solveTimeoutMs: intFrom(env.GATEHOUSE_SOLVE_TIMEOUT_MS, 70_000, 'GATEHOUSE_SOLVE_TIMEOUT_MS', 1_000, 600_000),
  };
}
