import { app, session as electronSession } from 'electron';
import { loadConfig } from './config.js';
import { BrowserPool } from './browser/pool.js';
import { makeSolver } from './browser/solve.js';
import { JobQueue } from './jobs/queue.js';
import { startServer } from './api/server.js';
import type { Solution, SolveRequest, V1Deps } from './api/v1.js';
import { log } from './log.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

// A headless solver has no dock/taskbar presence and must not quit when its last hidden
// window closes.
app.on('window-all-closed', () => { /* keep running */ });

/** What to print for a bind that names no reachable address of its own. */
const WILDCARD_LOOPBACK: Record<string, string> = { '0.0.0.0': '127.0.0.1', '::': '[::1]' };

async function start(): Promise<void> {
  const cfg = loadConfig(process.env);
  const pool = new BrowserPool();
  const solve = makeSolver(pool);

  const queue = new JobQueue<SolveRequest, Solution>({
    concurrency: cfg.concurrency,
    idgen: () => randomUUID(),
    now: () => Date.now(),
    run: (payload) => solve(payload),
  });

  const deps: V1Deps = {
    // Every /v1 solve goes through the queue, so concurrency and dedupe apply to it too.
    solve: async (incoming) => {
      // The ceiling in /v1 is the client's; this one is the operator's. The deadline the
      // solver enforces is `maxTimeout`, so clamping here is the only thing that makes
      // GATEHOUSE_SOLVE_TIMEOUT_MS mean anything — unclamped it is a knob wired to nothing.
      const req: SolveRequest = {
        ...incoming,
        maxTimeout: Math.min(incoming.maxTimeout, cfg.solveTimeoutMs),
      };
      // NUL-separated: NUL cannot occur in a command, a session name, a URL, or form-encoded
      // post data, so no two distinct requests can collide onto one dedupe key. The command
      // leads because without it a `request.post` carrying no body and a `request.get` to the
      // same URL share a key — and the GET caller is then handed a POST navigation's result.
      const job = queue.submit(
        `${req.cmd}\u0000${req.session}\u0000${req.url}\u0000${req.postData ?? ''}`,
        req,
      );
      const settled = await queue.wait(job.id);
      if (settled.state === 'done' && settled.result) return settled.result;
      throw Object.assign(new Error(settled.error?.message ?? 'solve failed'), { code: settled.error?.code });
    },
    now: () => Date.now(),
    version,
    sessions: new Set<string>(),
    // Destroy means destroy: the warm window goes, then the cookies on disk. Either alone
    // leaves the cleared token in play for the next solve on this name.
    destroySession: async (name) => {
      pool.destroySession(name);
      await electronSession.fromPartition(`persist:${name}`).clearStorageData();
    },
  };

  const health = () => ({
    version,
    browsers: { busy: pool.busy, total: pool.total },
    queue: { depth: queue.depth },
  });

  const server = await startServer(cfg, deps, health);
  // The integration harness waits for this exact line, and a human pastes it into a client —
  // so it has to be dialable. A wildcard bind is an instruction to `listen`, not an address:
  // `http://0.0.0.0:8191` connects nowhere useful. Advertise the loopback the wildcard covers.
  const host = WILDCARD_LOOPBACK[cfg.bind] ?? cfg.bind;
  process.stdout.write(`GATEHOUSE_READY http://${host}:${server.port}\n`);
  app.on('before-quit', () => { pool.destroy(); void server.close(); });
}

// Startup runs entirely inside the guard. loadConfig, the pool and the solver used to sit
// outside it, so a ConfigError — the sentence telling an operator to set GATEHOUSE_TOKEN —
// surfaced as a raw unhandled rejection instead of a logged message and a clean exit.
void app.whenReady().then(async () => {
  try {
    await start();
  } catch (e: unknown) {
    log.error(e instanceof Error ? e.message : String(e));
    app.exit(1);
  }
});
