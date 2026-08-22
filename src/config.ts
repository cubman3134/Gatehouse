import { isAbsolute } from 'node:path';

export class ConfigError extends Error {}

export interface GatehouseConfig {
  port: number;
  bind: string;
  token: string | null;
  concurrency: number;
  solveTimeoutMs: number;
  /** Absolute path for downloaded files. Empty means "derive from Electron's userData". */
  downloadsDir: string;
  downloadConcurrency: number;
  /**
   * How long one transfer may go without its `received` counter advancing before it is
   * aborted. An IDLE window, not a duration cap — a legitimate multi-GB download is allowed
   * to take hours.
   */
  downloadStallMs: number;
  /** How long a completed download's bytes survive without being released. */
  downloadTtlMs: number;
  /** Cap on the downloads directory; least-recently-accessed completed files evict first. */
  downloadMaxBytes: number;
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

  // A relative path would be resolved against the process's cwd, which is wherever
  // `electron .` happened to be launched from — a different directory after a restart from
  // another shell, and a meaningless string in `result.path`, which is documented as a path a
  // consumer hands to another process. Silently resolving it would pick one of two plausible
  // intents (cwd-relative, or relative to the app's userData) without being told which, so
  // refuse instead and let the operator say what they meant.
  const downloadsDir = env.GATEHOUSE_DOWNLOADS_DIR?.trim() || '';
  if (downloadsDir !== '' && !isAbsolute(downloadsDir)) {
    throw new ConfigError(
      `GATEHOUSE_DOWNLOADS_DIR must be an absolute path, got ${JSON.stringify(downloadsDir)}. ` +
        `A relative one would resolve against whatever directory the app was launched from.`,
    );
  }

  return {
    bind,
    token,
    port: intFrom(env.GATEHOUSE_PORT, 8191, 'GATEHOUSE_PORT', 0, 65535),
    concurrency: intFrom(env.GATEHOUSE_CONCURRENCY, 2, 'GATEHOUSE_CONCURRENCY', 1, 16),
    solveTimeoutMs: intFrom(env.GATEHOUSE_SOLVE_TIMEOUT_MS, 70_000, 'GATEHOUSE_SOLVE_TIMEOUT_MS', 1_000, 600_000),
    downloadsDir,
    downloadConcurrency: intFrom(env.GATEHOUSE_DOWNLOAD_CONCURRENCY, 2, 'GATEHOUSE_DOWNLOAD_CONCURRENCY', 1, 16),
    // 120s, and the floor of 5000 is deliberate. `transfer` only persists `received` every
    // PROGRESS_BYTES (4MB), so this window has to be comfortably longer than the time to move
    // 4MB on the slowest link worth serving: at 256 kbit/s that is ~130s of wall clock with
    // ZERO observable progress, and 120s already sits near that line. Do not tighten this
    // without moving the progress throttle down with it, or a slow-but-healthy download is
    // killed for looking idle.
    downloadStallMs: intFrom(env.GATEHOUSE_DOWNLOAD_STALL_MS, 120_000, 'GATEHOUSE_DOWNLOAD_STALL_MS', 5_000, 3_600_000),
    downloadTtlMs: intFrom(env.GATEHOUSE_DOWNLOAD_TTL_MS, 86_400_000, 'GATEHOUSE_DOWNLOAD_TTL_MS', 60_000, 2_592_000_000),
    downloadMaxBytes: intFrom(
      env.GATEHOUSE_DOWNLOAD_MAX_BYTES, 50 * 1024 * 1024 * 1024, 'GATEHOUSE_DOWNLOAD_MAX_BYTES',
      1024 * 1024, Number.MAX_SAFE_INTEGER,
    ),
  };
}
