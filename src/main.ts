import { app, net, session as electronSession } from 'electron';
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
import { transfer, STALLED, type Requester, type TransferResponse } from './downloads/transfer.js';
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

/**
 * A `Requester` over Electron's `net`, issued on a named partition.
 *
 * This is the point of the whole increment. `net.request` with a `session` sends the bytes
 * down the same partition that solved the challenge, so they carry that partition's cookies
 * and Chromium's TLS/HTTP2 fingerprint — not Node's. A host that hands a `cf_clearance`
 * holder a file and hands Node a challenge page cannot tell this apart from the browser it
 * already let through, because it *is* that browser's network stack.
 *
 * `transfer` tests the same seam through `nodeRequester`; keeping both behind one narrow
 * interface is what lets the download logic be tested without an Electron.
 */
export function electronRequester(): Requester {
  return (req, signal) =>
    new Promise<TransferResponse>((resolve, reject) => {
      // A signal that has already fired never calls its listener, so an early cancel has to be
      // caught before anything is registered or it is not caught at all.
      if (signal.aborted) { reject(new Error('cancelled before the request was issued')); return; }

      const request = net.request({
        url: req.url,
        session: electronSession.fromPartition(`persist:${req.session}`),
      });
      for (const [k, v] of Object.entries(req.headers)) request.setHeader(k, v);

      let answered = false;
      // Without this, a host that accepts the socket and then says nothing holds this promise
      // open forever: the transfer only wires the signal to the *response*, so during the
      // request phase nothing else is listening. That leaves an unsettled promise and a
      // `running` record no sweep may reclaim. Rejecting is what `transfer` expects — it maps
      // a rejection with an aborted signal onto `cancelled`, not onto a network fault.
      const onAbort = (): void => {
        request.abort();
        if (!answered) reject(new Error('cancelled before the response arrived'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      request.on('response', (res) => {
        answered = true;
        signal.removeEventListener('abort', onAbort);
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        }
        resolve({
          status: res.statusCode,
          headers: flat,
          body: res as unknown as AsyncIterable<Uint8Array>,
          abort: () => request.abort(),
        });
      });
      // Once the response is in the caller's hands a socket fault surfaces on the body stream
      // instead, and this promise is already settled — guard rather than leave it to chance.
      request.on('error', (e: Error) => { if (!answered) reject(e); });
      request.end();
    });
}

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
  const request = electronRequester();

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
      try {
        await transfer(id, store, request, ac.signal);
      } finally {
        stopWatchdog();
        aborts.delete(id);
        // Retention is enforced after every transfer, not on a timer: the thing that grows the
        // directory is a transfer finishing, so that is when the cap needs testing.
        await store.sweep();
      }
    },
  });

  /**
   * The idle watchdog. A host that accepts the socket and then writes NOTHING produces no
   * response and no error, so nothing inside the transfer ever fires: it holds a concurrency
   * slot until the process restarts, and with the default of two slots, two such hosts wedge
   * the whole download surface while `/gh/fetch` keeps handing out 202s that never run. A
   * caller DELETE is the only other thing that can free it, and a caller with no timeout of
   * its own never sends one.
   *
   * IDLE, not total: the clock is reset by progress, so a legitimate multi-GB transfer may run
   * for hours. It fires only when `received` has not moved for a whole window. `transfer`
   * persists `received` every 4MB, so the window must stay comfortably larger than the time to
   * move 4MB on a slow link -- 120s is; see the note on the range in `config.ts` before anyone
   * tightens it.
   *
   * Aborting is ALL this does. `transfer` notices the signal, closes its stream and only then
   * settles the record, so the single terminal-state writer stays where it is, per the
   * invariant in `downloads/record.ts`.
   *
   * The abort carries a REASON, though, and that is what stops it lying to the caller. Aborting
   * bare would land on the transfer's cancel path: the partial deleted and the record settled
   * `cancelled` — a 40GB download binned at 95% because the host went quiet, reported with a
   * code that reads as the caller's own doing. Passing `STALLED` lets `transfer` tell the two
   * apart on `signal.reason` and settle a stall as `failed`/`network` with its partial kept, so
   * a re-POST resumes it. Still one settle site; only the reason crosses.
   */
  function watchForStall(id: string, ac: AbortController): () => void {
    let lastReceived = store.get(id)?.received ?? 0;
    let lastProgressAt = Date.now();
    // A quarter of the window, so the abort lands within 1.25x of it rather than 2x. The floor
    // stops a small configured window from turning this into a busy poll.
    const tick = Math.max(250, Math.floor(cfg.downloadStallMs / 4));
    const timer = setInterval(() => {
      const rec = store.get(id);
      // Gone, or already settled by the transfer itself: there is nothing left to abort.
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
    // The transfer holds the process up on its own; an interval that outlived it would be a
    // leak on a daemon that runs for weeks, and would abort a later job sharing the id.
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** The one place that hands an id to the download queue: `/gh/fetch` and the resume below. */
  const submitDownload = (id: string): void => {
    aborts.set(id, new AbortController());
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
  //      re-submits it -- which would leave `transfer`'s resume path with no caller at all.
  //      Put the ones that still have a partial back on the queue under their ORIGINAL ids, so
  //      a consumer polling `/gh/jobs/<id>` across a restart sees it resume rather than a dead
  //      `failed`.
  //   2. THEN sweep, which is what reclaims the rest of the interrupted bytes and enforces the
  //      cap across restarts. Second, not first: a re-queued record is unsettled again and the
  //      sweep never touches an unsettled record, so this ordering is what stops the sweep
  //      deleting a partial we are about to resume from.
  await requeueInterrupted(store, submitDownload);
  await store.sweep();

  // Startup and after-every-transfer are both event-driven, and between them they miss the one
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
    // Fire-and-forget by design. The transfer notices the abort, closes its stream, drops its
    // partial and only then marks the record cancelled — settling here would race that writer.
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
  app.on('before-quit', () => { clearInterval(sweepTimer); pool.destroy(); void server.close(); });
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
