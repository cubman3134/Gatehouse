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
  /**
   * How long to wait for a download to begin at all before giving up.
   *
   * A different fault from a stall, and normally a tighter bound: a host that accepts the
   * socket and then writes nothing never fires `will-download`, so there is no item and no
   * bytes. This one names that precisely — nothing ever began.
   *
   * **The two are deliberately not constrained against each other, and the ordering decides
   * which one speaks.** The idle watchdog seeds its clock unconditionally rather than waiting
   * for an item, so a request-phase hang is inside both windows at once and the shorter one
   * reports it. At the defaults (60s here, 120s there) that is this timer. Set
   * `GATEHOUSE_DOWNLOAD_STALL_MS` lower than this and the same host settles as a download that
   * stopped advancing instead — true, but less specific. No relationship is enforced because
   * the inversion is genuinely useful: it is how a test reaches the watchdog without sitting
   * through a 60s request phase.
   *
   * **A recipe puts a third budget in front of both**, and at the defaults the three meet
   * exactly: `recipeTotalMs` (60s) + this (60s) = `downloadStallMs` (120s), to the millisecond.
   * That arithmetic used to matter, because the idle watchdog's clock started when the job did
   * and therefore ran through the page load and every step — a recipe that legitimately spent
   * its budget handed the transfer a window of nothing and could settle as one that "stopped
   * advancing". It no longer does: the watchdog is restarted the moment an item is adopted
   * (`BrowserDownloadDeps.onItemAdopted`), so the stall window is measured over the transfer
   * and the three budgets no longer have to be reasoned about together. The pair above is
   * still an ordering question, and still unconstrained.
   */
  downloadNoStartMs: number;
  /** How long a completed download's bytes survive without being released. */
  downloadTtlMs: number;
  /** Cap on the downloads directory; least-recently-accessed completed files evict first. */
  downloadMaxBytes: number;
  /**
   * How long one recipe step may wait for its element before the step fails.
   *
   * A *step* budget, not a recipe one: it is handed down to the page, which polls to it, and
   * the main process races the same deadline so a bridge that never answers cannot hang the
   * job. A site that reveals its link after an animation needs seconds, not milliseconds; a
   * selector that will never match should not cost a minute.
   */
  recipeStepMs: number;
  /**
   * Ceiling on a whole recipe, across all its steps.
   *
   * Twelve steps at the default step budget would otherwise be three minutes of held download
   * slot for a page that has silently changed its markup. The smaller of the two budgets is
   * what a step is actually given, so a late step cannot spend a full step timeout past the
   * end of this one.
   */
  recipeTotalMs: number;
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
    // 120s, and the floor of 5000 is deliberate. The download engine only persists `received`
    // every PROGRESS_BYTES (4MB), so this window has to be comfortably longer than the time to
    // move 4MB on the slowest link worth serving: at 256 kbit/s that is ~130s of wall clock
    // with ZERO observable progress, and 120s already sits near that line. Do not tighten this
    // without moving the progress throttle down with it, or a slow-but-healthy download is
    // killed for looking idle.
    downloadStallMs: intFrom(env.GATEHOUSE_DOWNLOAD_STALL_MS, 120_000, 'GATEHOUSE_DOWNLOAD_STALL_MS', 5_000, 3_600_000),
    // 60s. This one measures the request phase only — nothing has been received yet, so it is
    // not competing with the progress throttle the stall window has to clear, and it can be
    // much tighter. The floor of 5000 keeps it from firing on an ordinary slow TLS handshake.
    downloadNoStartMs: intFrom(env.GATEHOUSE_DOWNLOAD_NO_START_MS, 60_000, 'GATEHOUSE_DOWNLOAD_NO_START_MS', 5_000, 600_000),
    downloadTtlMs: intFrom(env.GATEHOUSE_DOWNLOAD_TTL_MS, 86_400_000, 'GATEHOUSE_DOWNLOAD_TTL_MS', 60_000, 2_592_000_000),
    downloadMaxBytes: intFrom(
      env.GATEHOUSE_DOWNLOAD_MAX_BYTES, 50 * 1024 * 1024 * 1024, 'GATEHOUSE_DOWNLOAD_MAX_BYTES',
      1024 * 1024, Number.MAX_SAFE_INTEGER,
    ),
    // 15s. Long enough for a page that reveals its link behind a short animation or a
    // round-trip to the site's own backend; short enough that a selector a redesign broke
    // costs one of these per step rather than a minute.
    recipeStepMs: intFrom(env.GATEHOUSE_RECIPE_STEP_MS, 15_000, 'GATEHOUSE_RECIPE_STEP_MS', 1_000, 120_000),
    // 60s across every step. Deliberately NOT constrained against the step budget: the engine
    // hands a step the smaller of the two remaining budgets, so a total below a step's is
    // simply a tighter recipe, which is how a test reaches this bound without waiting.
    recipeTotalMs: intFrom(env.GATEHOUSE_RECIPE_TOTAL_MS, 60_000, 'GATEHOUSE_RECIPE_TOTAL_MS', 5_000, 600_000),
  };
}
