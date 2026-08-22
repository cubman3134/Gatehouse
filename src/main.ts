import { app } from 'electron';
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

void app.whenReady().then(async () => {
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
    solve: async (req) => {
      // NUL-separated: NUL cannot occur in a session name, a URL, or form-encoded post data,
      // so no two distinct requests can collide onto one dedupe key.
      const job = queue.submit(`${req.session}\u0000${req.url}\u0000${req.postData ?? ''}`, req);
      const settled = await queue.wait(job.id);
      if (settled.state === 'done' && settled.result) return settled.result;
      throw Object.assign(new Error(settled.error?.message ?? 'solve failed'), { code: settled.error?.code });
    },
    now: () => Date.now(),
    version,
    sessions: new Set<string>(),
  };

  const health = () => ({
    version,
    browsers: { busy: pool.busy, total: pool.total },
    queue: { depth: queue.depth },
  });

  try {
    const server = await startServer(cfg, deps, health);
    // The integration harness waits for this exact line.
    process.stdout.write(`GATEHOUSE_READY http://${cfg.bind}:${server.port}\n`);
    app.on('before-quit', () => { pool.destroy(); void server.close(); });
  } catch (e: unknown) {
    log.error(e instanceof Error ? e.message : String(e));
    app.exit(1);
  }
});
