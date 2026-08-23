import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron';
import { loadConfig } from './config.js';
import { BrowserPool } from './browser/pool.js';
import { makeSolver } from './browser/solve.js';
import { JobQueue } from './jobs/queue.js';
import { startServer } from './api/server.js';
import type { Solution, SolveRequest, V1Deps } from './api/v1.js';
import type { GhDeps } from './api/gh.js';
import { DownloadStore } from './downloads/store.js';
import { requeueInterrupted } from './downloads/resume.js';
import { isSettled } from './downloads/record.js';
import { browserDownload } from './downloads/browser.js';
import { STALLED } from './downloads/stalled.js';
import type { Recipe } from './downloads/recipe.js';
import { recipePreloadPath } from './preload/path.js';
import { log } from './log.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

// A headless solver has no dock/taskbar presence and must not quit when its last hidden
// window closes.
app.on('window-all-closed', () => { /* keep running */ });

/** What to print for a bind that names no reachable address of its own. */
const WILDCARD_LOOPBACK: Record<string, string> = { '0.0.0.0': '127.0.0.1', '::': '[::1]' };

/**
 * How often retention is enforced on a daemon with nothing to do. Deliberately coarse: the
 * event-driven sweeps below do the real work, and this only exists so that "expired" means
 * something on a box where nobody downloads anything for a week.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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

  // Empty means "derive it" — the config layer cannot, because `app.getPath` only answers
  // once Electron is ready and `loadConfig` is a pure function over the environment.
  const downloadsDir = cfg.downloadsDir || join(app.getPath('userData'), 'downloads');
  const store = new DownloadStore({
    dir: downloadsDir,
    now: () => Date.now(),
    idgen: () => randomUUID(),
    ttlMs: cfg.downloadTtlMs,
    maxBytes: cfg.downloadMaxBytes,
  });
  await store.load();

  const aborts = new Map<string, AbortController>();

  /**
   * Recipes in flight, by record id — **memory only, never the manifest.**
   *
   * A recipe is a caller's contract with a site's markup: selectors, and sometimes the visible
   * text of a button. None of that belongs in a file an operator reads or that is rewritten on
   * every progress tick, so it lives here and dies with the process. The record keeps a
   * `viaRecipe` flag and nothing else, which is what lets the engine refuse to "restart" a
   * recipe download by downloading the page it started from.
   *
   * Entries are deleted by the runner below, on every path, or a daemon that runs for weeks
   * accumulates one per download that was cancelled before its slot opened.
   */
  const recipes = new Map<string, Recipe>();
  // Resolved from `import.meta.url`, once, so the path is the same whatever launched the app.
  const recipePreload = recipePreloadPath();

  const downloads = new JobQueue<string, void>({
    concurrency: cfg.downloadConcurrency,
    idgen: () => randomUUID(),
    now: () => Date.now(),
    run: async (id) => {
      // The controller was made at submit time, so a DELETE that lands while the job is still
      // QUEUED has something to abort. Taking a fresh one here would drop that cancel on the
      // floor and the record would sit queued until the process restarted.
      const ac = aborts.get(id) ?? new AbortController();
      aborts.set(id, ac);
      const stopWatchdog = watchForStall(id, ac);
      const recipe = recipes.get(id);
      try {
        await browserDownload(id, {
          store,
          // The partition that solved the challenge. Its cookies AND its network stack come
          // with it, which is the entire point: `net.request` on this same partition is
          // refused 403 by a fingerprinting host even holding a valid clearance, and only the
          // browser's own download stack gets the bytes. See the README's live-verification
          // table before reintroducing anything that fetches by hand.
          partitionFor: (name) => electronSession.fromPartition(`persist:${name}`),
          // ONE HIDDEN WINDOW PER JOB, and it is not a style choice. `will-download` fires on
          // the session, and for two concurrent downloads of the same URL every field on the
          // item is identical while fire order does not match call order — the `webContents`
          // argument is the only discriminator there is. A shared window makes the two jobs
          // indistinguishable. `test/integration/browser-download.test.ts` downloads the same
          // URL twice at once as the regression net for exactly that.
          //
          // A recipe download's window additionally gets the bridge preload — and keeps every
          // other setting exactly as it is. `sandbox: true` in particular is not negotiable:
          // the preload is hand-written CommonJS precisely so the sandbox can stay on (a
          // sandboxed preload refuses ESM, and the file format was the cheaper thing to give
          // up). `contextIsolation` keeps the bridge out of the page's reach, so a hostile
          // renderer cannot see `ipcRenderer` or forge a step result.
          makeWindow: (name, preload) => new BrowserWindow({
            show: false,
            webPreferences: {
              partition: `persist:${name}`,
              ...(preload ? { preload } : {}),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          }),
          noStartMs: cfg.downloadNoStartMs,
          stallMs: cfg.downloadStallMs,
          ...(recipe
            ? {
                recipe: {
                  recipe,
                  stepMs: cfg.recipeStepMs,
                  totalMs: cfg.recipeTotalMs,
                  preload: recipePreload,
                  ipc: ipcMain,
                },
              }
            : {}),
        }, ac.signal);
      } finally {
        stopWatchdog();
        aborts.delete(id);
        // On EVERY path, settled or cancelled: the map is the only thing holding this recipe.
        recipes.delete(id);
        // Retention is enforced after every download, not on a timer: the thing that grows the
        // directory is a download finishing, so that is when the cap needs testing.
        await store.sweep();
      }
    },
  });

  /**
   * The idle watchdog. A host that accepts the socket and then goes quiet mid-body produces no
   * error and no `done` — measured, an interrupted item sat that way past 300s — so it holds a
   * concurrency slot until the process restarts, and with the default of two slots two such
   * hosts wedge the whole download surface while `/gh/fetch` keeps handing out 202s that never
   * run. A caller DELETE is the only other thing that can free it, and a caller with no timeout
   * of its own never sends one.
   *
   * It overlaps `browserDownload`'s own no-start timer without duplicating it. That one bounds
   * the REQUEST phase, where there is no item at all; this one bounds an item that exists and
   * has stopped moving. Both are needed, and each names the fault it measures.
   *
   * WHICH of the two names a given fault is an ordering question, though, and the config does
   * not settle it. This watchdog seeds its clock unconditionally, so it does not need an item
   * to fire: a host that accepts the socket and never writes a status line is inside BOTH
   * windows at once, and whichever elapses first is the one that reports it. With the defaults
   * (60s no-start, 120s stall) that is the no-start timer, which is the tighter bound and the
   * more precise description. Configure `GATEHOUSE_DOWNLOAD_STALL_MS` below
   * `GATEHOUSE_DOWNLOAD_NO_START_MS` — which is allowed, and which
   * `test/integration/download.test.ts` does deliberately, to reach this watchdog in a bounded
   * test — and a request-phase hang is reported here instead, as a download that stopped
   * advancing. Not wrong (it never advanced), but less specific than the timer that would have
   * said "nothing ever began". See the note on the pair in `config.ts`.
   *
   * IDLE, not total: the clock is reset by progress, so a legitimate multi-GB download may run
   * for hours. It fires only when `received` has not moved for a whole window. The engine
   * persists `received` every 4MB, so the window must stay comfortably larger than the time to
   * move 4MB on a slow link -- 120s is; see the note on the range in `config.ts` before anyone
   * tightens it.
   *
   * Aborting is ALL this does. `browserDownload` notices the signal, cancels the item and
   * settles from its `done`, so the single terminal-state writer stays where it is, per the
   * invariant in `downloads/record.ts`.
   *
   * The abort carries a REASON, though, and that is what stops it lying to the caller. Aborting
   * bare would land on the cancel path and settle `cancelled` — a 40GB download binned at 95%
   * because the host went quiet, reported with a code that reads as the caller's own doing.
   * Passing `STALLED` lets the engine tell the two apart on `signal.reason` and settle a stall
   * as the retryable host fault it is, `failed`/`network`. Still one settle site; only the
   * reason crosses.
   *
   * What it does NOT buy is kept bytes. Ending a stalled browser download means `item.cancel()`
   * and Chromium deletes the partial of an item it cancelled, so a stalled record settles with
   * nothing on disk. Mid-transfer resilience comes from Chromium's own retry of a dropped
   * ranged transfer instead; ours is the restart path in `requeueInterrupted`.
   */
  function watchForStall(id: string, ac: AbortController): () => void {
    let lastReceived = store.get(id)?.received ?? 0;
    let lastProgressAt = Date.now();
    // A quarter of the window, so the abort lands within 1.25x of it rather than 2x. The floor
    // stops a small configured window from turning this into a busy poll.
    const tick = Math.max(250, Math.floor(cfg.downloadStallMs / 4));
    const timer = setInterval(() => {
      const rec = store.get(id);
      // Gone, or already settled by the engine itself: there is nothing left to abort.
      if (!rec || isSettled(rec.state)) { clearInterval(timer); return; }
      if (rec.received !== lastReceived) {
        lastReceived = rec.received;
        lastProgressAt = Date.now();
        return;
      }
      if (Date.now() - lastProgressAt < cfg.downloadStallMs) return;
      clearInterval(timer);
      log.warn('aborting a download that made no progress within the stall window', {
        id, received: rec.received, stallMs: cfg.downloadStallMs,
      });
      ac.abort(STALLED);
    }, tick);
    // The download holds the process up on its own; an interval that outlived it would be a
    // leak on a daemon that runs for weeks, and would abort a later job sharing the id.
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** The one place that hands an id to the download queue: `/gh/fetch` and the resume below. */
  const submitDownload = (id: string, recipe?: Recipe): void => {
    aborts.set(id, new AbortController());
    // Beside the record, not on it. The restart path calls this with no recipe at all, which is
    // exactly the case `viaRecipe` exists to make loud rather than silent.
    if (recipe) recipes.set(id, recipe);
    // NUL-separated, the same convention the solve queue uses above -- written as an
    // escape, not a literal control character in the source. One record id is unique on
    // its own so this key cannot collide; the real dedupe is `store.findOpen`, which folds
    // two requests for the same session+url onto one record before either reaches here.
    downloads.submit(`dl\u0000${id}`, id);
  };

  // On the way up, before anything can be served, and in this order:
  //
  //   1. `load` has just demoted every record the previous process left unsettled to `failed`.
  //      That is a safe default, but on its own it strands an interrupted download: `failed`
  //      is settled, so `findOpen` will not return it, a re-POST mints a new id and a new
  //      `.part`, and the bytes already on disk are orphaned until the TTL sweep. Nothing
  //      re-submits it -- which would leave the engine's resume path with no caller at all.
  //      Put the ones that still have a partial back on the queue under their ORIGINAL ids, so
  //      a consumer polling `/gh/jobs/<id>` across a restart sees it resume rather than a dead
  //      `failed`.
  //   2. THEN sweep, which is what reclaims the rest of the interrupted bytes and enforces the
  //      cap across restarts. Second, not first: a re-queued record is unsettled again and the
  //      sweep never touches an unsettled record, so this ordering is what stops the sweep
  //      deleting a partial we are about to resume from.
  await requeueInterrupted(store, submitDownload);
  await store.sweep();

  // Startup and after-every-download are both event-driven, and between them they miss the one
  // case the TTL is actually a promise about: a daemon that goes quiet. Nothing finishes, so
  // nothing sweeps, and expired bytes sit on disk until the next download — which on an idle
  // box may be never. `unref` so this can never be the reason the process stays alive, and it
  // is cleared on the way out below.
  const sweepTimer = setInterval(() => {
    // `void`ed, so the `catch` is not optional: `sweep` reaches the filesystem, and an
    // unhandled rejection in a daemon is `exit 1`.
    void store.sweep().catch((e: unknown) => {
      log.warn('the periodic retention sweep failed', { message: e instanceof Error ? e.message : String(e) });
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  const ghDeps: GhDeps = {
    store,
    // `submit` returns a job record; nothing here awaits it, and the queue captures a failing
    // `run` itself, so no rejection escapes into this void-ed call site.
    submit: submitDownload,
    // Fire-and-forget by design. The engine notices the abort, cancels the browser's item and
    // only settles the record once Chromium has released the file — settling here would race
    // that writer.
    cancel: (id) => { aborts.get(id)?.abort(); },
    now: () => Date.now(),
  };

  const health = () => ({
    version,
    browsers: { busy: pool.busy, total: pool.total },
    queue: { depth: queue.depth },
    downloads: { active: downloads.busy, records: store.all().length },
  });

  const server = await startServer(cfg, deps, health, ghDeps);
  // The integration harness waits for this exact line, and a human pastes it into a client —
  // so it has to be dialable. A wildcard bind is an instruction to `listen`, not an address:
  // `http://0.0.0.0:8191` connects nowhere useful. Advertise the loopback the wildcard covers.
  const host = WILDCARD_LOOPBACK[cfg.bind] ?? cfg.bind;
  process.stdout.write(`GATEHOUSE_READY http://${host}:${server.port}\n`);
  app.on('before-quit', () => {
    clearInterval(sweepTimer);
    pool.destroy();
    // `void`ed, so the `catch` is not optional. `close()` rejects with ERR_SERVER_NOT_RUNNING
    // if anything already closed the listener — a second quit signal, or a listen that never
    // came up — and on the way out of the process an unhandled rejection is the last thing an
    // operator needs in the log. There is nothing to do about it but say so.
    void server.close().catch((e: unknown) => {
      log.warn('the HTTP server did not close cleanly', {
        message: e instanceof Error ? e.message : String(e),
      });
    });
  });
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
