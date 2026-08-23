import { stat, rm, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { BrowserWindow, DownloadItem, Event, Session, WebContents } from 'electron';
import type { DownloadStore } from './store.js';
import type { DownloadRecord, FailureCode } from './record.js';
import { planResume } from './resumable.js';
import { STALLED } from './stalled.js';
import {
  runRecipe,
  isRecipeError,
  STEP_CHANNEL,
  RESULT_CHANNEL,
  type Recipe,
  type RecipeStep,
  type StepResult,
} from './recipe.js';
import { validateTarget, isTargetError } from '../api/target.js';
import { log } from '../log.js';

/**
 * How many bytes may arrive before progress is persisted again.
 *
 * Progress goes into the manifest, and the manifest is rewritten and renamed on every update,
 * so an update per `updated` event is thousands of fsyncs on a large file — Chromium fires that
 * event far more often than four megabytes apart. This is the same 4MB throttle the byte-stream
 * transfer used, and deliberately so: the idle watchdog's stall window is sized against exactly
 * this number ("the window must stay comfortably larger than the time to move 4MB on a slow
 * link"), so changing it here changes what counts as a stall.
 */
export const PROGRESS_BYTES = 4 * 1024 * 1024;

/**
 * How long past a step's own deadline the main process waits before declaring the bridge silent.
 *
 * Both halves race the same absolute deadline: the page polls to it and answers "matched
 * nothing within the step timeout", and this side times out in case that answer never comes.
 * Without the grace the two are a photo finish and the *wiring* message wins about half the
 * time — telling an operator the bridge may be broken when in truth the selector matched
 * nothing. One IPC round trip on loopback is sub-millisecond; this is three orders of magnitude
 * of slack, and it is bounded, which is the property that actually matters.
 */
const BRIDGE_GRACE_MS = 500;

/**
 * The main-process half of the recipe bridge — `ipcMain`, structurally.
 *
 * Injected rather than imported for the reason the whole module keeps `import type` from
 * electron: `test/unit/browser.test.ts` loads this file outside an Electron runtime, where
 * `ipcMain` is undefined, and an import of it as a *value* would take that suite down at load.
 */
export interface RecipeIpc {
  on(channel: string, listener: (event: { sender: { id: number } }, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: { sender: { id: number } }, ...args: unknown[]) => void): void;
}

/** Everything the recipe branch needs. Absent on an ordinary download, which is most of them. */
export interface RecipeRun {
  recipe: Recipe;
  /** Per step; the page polls to whichever of the two remaining budgets is smaller. */
  stepMs: number;
  /** Across the whole recipe. */
  totalMs: number;
  /**
   * Absolute path of the preload that answers the step channel.
   *
   * Checked for existence before the window is made, because a missing preload fails
   * SILENTLY: measured, the window loads, the page renders, the renderer stays alive,
   * `preload-error` fires, and every step then hangs waiting for a listener that was never
   * attached. A wiring fault must not present as a site that stopped responding.
   */
  preload: string;
  ipc: RecipeIpc;
}

export interface BrowserDownloadDeps {
  store: DownloadStore;
  /** The partition that solved the challenge — the cookies and fingerprint come with it. */
  partitionFor: (session: string) => Session;
  /**
   * A hidden window on that partition, owned by this call and destroyed by it. `preload` is the
   * recipe bridge's absolute path for a recipe download, and `null` for every other one — an
   * ordinary download loads no page and needs no bridge in its renderer.
   */
  makeWindow: (session: string, preload: string | null) => BrowserWindow;
  /** How long to wait for `will-download` to fire at all before giving up. */
  noStartMs: number;
  /** How long `receivedBytes` may sit still before the transfer is judged stalled. */
  stallMs: number;
  /** Present only when this job's URL has to be derived by driving a page first. */
  recipe?: RecipeRun;
}

/** A thrown value into a `FailureCode`, matching the convention the job queue already uses. */
function failureOf(e: unknown): { code: FailureCode; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  const errno = (e as { code?: unknown } | null)?.code;
  return { code: errno === 'ENOSPC' ? 'disk-full' : 'network', message };
}

/** Reading a number off an item that Chromium may already have torn down must not throw. */
function receivedOf(dl: DownloadItem): number {
  try {
    return dl.getReceivedBytes();
  } catch {
    return 0;
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Uint8Array);
  return h.digest('hex');
}

/**
 * Download one record through the browser's own download stack.
 *
 * `net.request` is not used and must not be: measured against a real challenge-protected host,
 * every `net.request` variant was refused 403 while holding a valid clearance in the same
 * partition, and only the browser's download stack succeeded. Cloudflare tells the `net` client
 * from the renderer.
 *
 * **Two start paths, and they correlate their item differently.** `will-download` fires on the
 * *session*, so the only question that matters in the handler is "is this item mine?", and the
 * two paths answer it in different ways:
 *
 * | path | started by | correlated on |
 * |---|---|---|
 * | fresh | `win.webContents.downloadURL(url)` | the handler's `webContents === win.webContents` |
 * | resume | `ses.createInterruptedDownload({path, …})` | a one-shot armed immediately before the call |
 *
 * A fresh download gets **its own hidden window, and that is not a style choice**: for
 * concurrent downloads of the same URL every field on the item — url, urlChain, filename, mime,
 * eTag, totalBytes — is identical, and fire order does not match call order. The `webContents`
 * argument is the only discriminator there is.
 *
 * A resume gets **no window at all**, and cannot use that discriminator even if it had one:
 * `createInterruptedDownload` is declared only on `Session` — there is no window-scoped resume
 * API — so the handler's third argument is `null`, structurally. What replaces it is ordering:
 * the event is emitted *synchronously, inside the call*, so a one-shot armed on the line above
 * captures that call's own item even when several resumes interleave. **There must be no
 * `await` between arming and calling** — that is the entire guarantee. It also means two
 * one-shots can never be armed at once, which is what stops one resume eating another's event.
 *
 * That reasoning needs one store invariant to hold: **two live records must never share a
 * `path`.** Ours are `<id>.part` with `randomUUID` ids, so it holds by construction — but if it
 * ever stopped holding, two resume items would be indistinguishable, one would never settle,
 * and its file would end up 0 bytes. `item.getSavePath() === part` is asserted below as a cheap
 * tripwire on both that and the undocumented synchronous emission.
 *
 * **Never rejects.** This is driven from a long-running daemon whose call site is `void`ed, so a
 * rejection here is an unhandled one — and a record left unsettled forever, which `findOpen`
 * would then fold every re-POST onto. Everything that can throw is inside the try/catch, and
 * `store.update` swallows its own persistence failures, so no settle can reject on the way out.
 *
 * **A recipe puts a page in front of all of that, and its ordering is load-bearing.** The window
 * is created with the bridge preload, `will-download` is attached **before anything navigates**,
 * and only then does the window load `startUrl` and the steps run. Attaching that handler later
 * is not a smaller version of the same thing: an item nobody claims makes Chromium open a native
 * modal Save As dialog that never resolves — measured, and fatal on a daemon — and a `click`
 * step is entirely free to start a download itself. Which is also the second legitimate way a
 * recipe ends: if an item arrives mid-recipe it **is** the result, the remaining steps are
 * abandoned, and no `readAttribute` needs to have produced anything.
 *
 * The URL a recipe derives is hostile input and goes through `validateTarget` here, on the way
 * out. `runRecipe` returns it deliberately unvalidated so that gate cannot be skipped by
 * accident; do not move it.
 *
 * **A record settles only after the writer released the file.** Chromium is the writer here and
 * its `done` event is the release, so every settle that concerns a file that was actually opened
 * happens inside that handler. The settles outside it — cancelled before the start, never
 * started — are reached only when no item ever existed, so nothing was open.
 */
export async function browserDownload(
  id: string,
  deps: BrowserDownloadDeps,
  signal: AbortSignal,
): Promise<void> {
  const rec = deps.store.get(id);
  if (!rec) return;

  let settled = false;
  /** The one writer of a terminal state. First one wins; later ones are no-ops. */
  const finish = async (patch: Partial<DownloadRecord>): Promise<void> => {
    if (settled) return;
    settled = true;
    await deps.store.update(id, patch);
  };

  /**
   * `completedAt` is stamped on a failure rather than left null. The retention sweep ages a
   * record from `completedAt ?? createdAt`, so without it a failure's TTL would run from when
   * the download *started* — and a download that ran for longer than the TTL before dying would
   * be reclaimable the instant it settled, its record gone before the caller's next poll.
   */
  const failedPatch = (
    code: FailureCode,
    message: string,
    received?: number,
  ): Partial<DownloadRecord> => {
    const patch: Partial<DownloadRecord> = {
      state: 'failed',
      error: { code, message },
      completedAt: deps.store.nowMs(),
    };
    if (received !== undefined) patch.received = received;
    return patch;
  };

  // Everything below may need releasing from the `finally`, whichever way this exits.
  let win: BrowserWindow | null = null;
  let item: DownloadItem | null = null;
  let noStart: ReturnType<typeof setTimeout> | undefined;
  // Left undeclared rather than initialised to `null`: both are assigned from inside nested
  // callbacks, which the control-flow analysis cannot see, so an initialiser would narrow them
  // to `null` for good and make the releases in the `finally` uncallable.
  let detachWillDownload: (() => void) | undefined;
  let detachAbort: (() => void) | undefined;
  let detachPreloadError: (() => void) | undefined;

  /**
   * The bridge's shared state, in an object rather than in two `let`s.
   *
   * Both fields are written from nested callbacks and read from another, which is precisely the
   * shape TypeScript's control-flow analysis cannot follow: a `let` narrowed to `null` at the
   * point a closure is created stays narrowed inside it. A property has no such narrowing, so
   * this reads as what it is — mutable state shared between the preload-error listener, the
   * download adopter and whichever step is currently in flight.
   */
  const bridge: {
    /** Set once `preload-error` has fired: the bridge in this renderer will never answer. */
    failure: string | null;
    /** Abandon the step currently in flight, with a reason. Null when no step is waiting. */
    abandon: ((why: string) => void) | null;
  } = { failure: null, abandon: null };

  try {
    const part = deps.store.partPath(id);
    const ses = deps.partitionFor(rec.session);

    /**
     * Best-effort, exactly as the store's own unlinks are. `rm`'s `force` suppresses ENOENT and
     * nothing else, so an EPERM or EBUSY from an antivirus scanner or a search indexer holding
     * the file — ordinary on Windows — would otherwise reject out of a function that promises
     * never to, or settle the record failed over a scanner hiccup.
     */
    const dropPartial = async (): Promise<void> => {
      try {
        await rm(part, { force: true });
      } catch (e: unknown) {
        log.warn('could not delete a download partial; the bytes remain until the sweep', {
          id,
          path: part,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    };

    /** A cancel is the caller's own doing and its bytes are unwanted, so the partial goes. */
    const settleCancelled = async (): Promise<void> => {
      // The flag is claimed FIRST, before the unlink. `dropPartial` awaits an `rm` that can take
      // real time on Windows, and a `noStart` expiry landing inside that window would otherwise
      // win the settle and record a caller's cancel as `failed`/`network` — wrong about who
      // acted, and reclaimable to boot.
      log.info('download cancelled', { id });
      await finish({
        state: 'cancelled',
        received: 0,
        completedAt: deps.store.nowMs(),
        error: { code: 'cancelled', message: 'cancelled by the caller' },
      });
      // Chromium already deletes the partial of an item it cancelled — including a paused one —
      // so this is usually a no-op; it is here for the cancel that lands before any item exists.
      // Unconditional, even when another path won the settle: a cancel's bytes are unwanted
      // whoever got there first.
      await dropPartial();
    };

    /**
     * A stall is a retryable HOST fault the caller never asked for, so it settles `failed` /
     * `network` rather than `cancelled`, which would be a lie about who acted. It is a settled
     * state like any other: there is no reclaim of it, and a re-POST for the same target mints
     * a fresh id and starts from zero.
     *
     * It keeps no bytes either. The only way to end a stalled browser download is `cancel()`,
     * and Chromium deletes the partial of an item it cancelled, so a stalled record settles
     * with nothing on disk.
     *
     * The message names the fault as the watchdog measures it: `received` stopped advancing.
     * NOT "no bytes arrived" — the window is idle, not total, so a download abandoned at 3GB
     * reaches here too and that phrasing would describe the wrong thing entirely.
     */
    const settleStalled = async (received: number): Promise<void> => {
      log.warn('download abandoned after a stall', { id, received, stallMs: deps.stallMs });
      await finish(
        failedPatch(
          'network',
          `the download stopped advancing for ${deps.stallMs}ms`,
          received,
        ),
      );
    };

    let partial = 0;
    try {
      partial = (await stat(part)).size;
    } catch {
      /* no partial */
    }

    const plan = planResume(rec, partial);
    if (plan.kind === 'restart' && partial > 0) {
      log.info('not resuming this partial, starting over', {
        id,
        reason: plan.reason,
        discarded: partial,
      });
      await dropPartial();
      partial = 0;
    }

    // Cancelled before anything was started. Opening a window and a socket only to tear them
    // down is pointless work, and leaving the record `running` would leave it unreclaimable.
    if (signal.aborted) {
      if (signal.reason === STALLED) await settleStalled(partial);
      else await settleCancelled();
      return;
    }

    // `received` is reset here so the record and the disk agree from the first tick: a restart
    // discarded its partial, and a resume starts from what survived.
    await deps.store.update(id, {
      state: 'running',
      received: plan.kind === 'resume' ? partial : 0,
    });

    /**
     * A recipe that is not here any more.
     *
     * Recipes live in memory beside the record, never on it, so a restart loses them. The
     * requeue path picks a record back up by id and this one's `url` is the *page*, not the
     * file — so a restart that could not resume the partial would "start over" by downloading
     * the HTML and settling `done` on it. That is a silent wrong answer, which is worth failing
     * loudly for. A resume is unaffected: it continues from the URL chain the derived download
     * already recorded, and never looks at `rec.url` at all.
     */
    if (rec.viaRecipe && plan.kind === 'restart' && !deps.recipe) {
      log.warn('a recipe download cannot be restarted without its recipe', { id, url: rec.url });
      await finish(failedPatch(
        'recipe-failed',
        'this download was derived from a recipe, which is not persisted across a restart; ' +
          'POST the recipe again to fetch it',
      ));
      return;
    }

    // A missing preload is the wiring fault that presents as a hanging site — the window loads,
    // the page renders, `preload-error` fires and every step waits for a listener that is not
    // there. Refuse before opening anything, and say which file.
    if (deps.recipe && plan.kind === 'restart' && !existsSync(deps.recipe.preload)) {
      log.error('the recipe bridge preload is missing', { id, preload: deps.recipe.preload });
      await finish(failedPatch(
        'recipe-failed',
        `the recipe bridge preload is missing at ${deps.recipe.preload}; this app is mis-wired, ` +
          `not the site`,
      ));
      return;
    }

    // A resume needs no window, and must not be given one — `createInterruptedDownload` is a
    // session API and would ignore it.
    if (plan.kind === 'restart') win = deps.makeWindow(rec.session, deps.recipe?.preload ?? null);
    // Captured once. Reading `win.webContents` later, after the window is destroyed, throws
    // from inside an emit — an uncaught exception in a daemon. The reference itself stays safe
    // to compare forever.
    const ownWebContents: WebContents | null = win ? win.webContents : null;

    /**
     * The second half of designing out the silent hang.
     *
     * A preload that exists but cannot be loaded — a syntax error, an `import` statement in a
     * sandboxed CommonJS file, a permission fault — does not stop the window, does not stop the
     * page and does not throw anywhere we would see it. It fires this, once, and then every
     * step waits forever. So the reason is captured the moment it happens and the step in flight
     * is abandoned with it, rather than being left to discover the silence for itself.
     */
    if (deps.recipe && ownWebContents) {
      const wc = ownWebContents;
      const onPreloadError = (_e: Event, preloadPath: string, error: Error): void => {
        const why = `the recipe bridge failed to load (${preloadPath}: ${error?.message ?? String(error)})`;
        bridge.failure = why;
        log.error('the recipe preload failed to load', { id, preload: preloadPath, reason: error?.message ?? String(error) });
        bridge.abandon?.(why);
      };
      wc.on('preload-error', onPreloadError);
      detachPreloadError = (): void => { wc.removeListener('preload-error', onPreloadError); };
    }

    await new Promise<void>((resolve) => {
      /** Wire an item we have decided is ours, and settle from its `done`. */
      const adopt = (dl: DownloadItem): void => {
        item = dl;
        // The recipe's second legitimate ending: a `click` started the download itself, so this
        // item IS the result and the remaining steps are pointless. Abandoning the step in
        // flight is what makes that immediate instead of one step timeout later.
        bridge.abandon?.('was abandoned because a download started while the recipe was running');

        let lastReported = receivedOf(dl);
        const onUpdated = (): void => {
          const got = receivedOf(dl);
          // Throttled: see PROGRESS_BYTES. The exact final figure is written on settle.
          if (got - lastReported >= PROGRESS_BYTES) {
            lastReported = got;
            void deps.store.update(id, { received: got });
          }
        };
        dl.on('updated', onUpdated);

        dl.once('done', (_e, state) => {
          // Chromium has closed the file by now, which is what makes the settles below safe
          // against a retention sweep and against the rename.
          dl.removeListener('updated', onUpdated);
          void (async () => {
            try {
              if (state === 'completed') {
                try {
                  const size = (await stat(part)).size;
                  const sha256 = await hashFile(part);
                  await rename(part, deps.store.filePath(id));
                  const now = deps.store.nowMs();
                  log.info('download complete', { id, size });
                  await finish({
                    state: 'done',
                    received: size,
                    size,
                    sha256,
                    completedAt: now,
                    lastAccessAt: now,
                  });
                } catch (e: unknown) {
                  // The bytes arrived but we could not hash or place them. Settling `done`
                  // anyway would promise a `<id>.bin` that is not there.
                  const error = failureOf(e);
                  log.warn('download arrived but could not be finalised', { id, ...error });
                  await finish(failedPatch(error.code, error.message, receivedOf(dl)));
                }
              } else if (signal.reason === STALLED) {
                // The bytes Chromium reported before it was cancelled, NOT 0. The record's
              // `received` legitimately becomes 0 because Chromium deletes the partial, but the
              // LOG has to say where the transfer actually got to — "stopped advancing" with
              // "received 0" reads as "never started" and misdirects the diagnosis of a stall
              // at 95%.
              log.warn('download stalled', { id, reachedBytes: receivedOf(dl) });
              await settleStalled(0);
              } else if (signal.aborted) {
                await settleCancelled();
              } else {
                // `interrupted`, or a `cancelled` nobody here asked for. The HTTP status is not
                // exposed anywhere on the item — a 404 arrives as an interrupt with 0 bytes and
                // no file — so there is no code to report beyond this.
                //
                // The partial, if any, GOES. Nothing can read it: the record settles `failed`,
                // which is settled, so `findOpen` will not return it and a re-POST mints a new
                // id; and the one resume caller there is — `requeueInterrupted` — matches only
                // a record `load()` demoted, on `code === 'cancelled'` plus
                // INTERRUPTED_BY_RESTART. Keeping the bytes would leave a file with no reader,
                // occupying the cap until the TTL sweep reclaimed it.
                //
                // The genuinely resumable case is a different one and is untouched by this: a
                // record still `running` when the process DIES leaves its `.part` behind
                // because nothing here ever runs, `load()` demotes it, and the resume picks it
                // up on the next start.
                const received = receivedOf(dl);
                log.warn('download did not complete', { id, state, received });
                await finish(failedPatch('network', `the download ${state}`, received));
                await dropPartial();
              }
            } catch (e: unknown) {
              // Nothing here may escape. This IIFE is detached, so a throw would surface as an
              // unhandled rejection — out of band from the promise the outer try/catch guards —
              // and take the daemon down. A settle has already been attempted; the most this can
              // do now is say so.
              log.error('download settle threw', {
                id, reason: e instanceof Error ? e.message : String(e),
              });
            } finally {
              resolve();
            }
          })();
        });
      };

      /**
       * The headers, as the item reports them, written once at the start of a FRESH download.
       *
       * This is the only place `resume` metadata is ever recorded, and without it a later
       * attempt cannot resume at all: Chromium keeps nothing across a restart, there is no
       * enumeration API, and `planResume` refuses outright when the record carries no metadata.
       *
       * It is deliberately NOT re-run on the resume path. The metadata there was captured when
       * the headers were fresh and has already passed `planResume`'s validator check; a resumed
       * item reports values derived from what we just handed it, so rewriting them can only
       * degrade what we have.
       */
      const recordHeaders = (dl: DownloadItem): void => {
        void deps.store.update(id, {
          // Metadata for the caller's benefit only — it is hostile input and never a path.
          suggestedName: dl.getFilename() || null,
          contentType: dl.getMimeType() || null,
          // 0 throughout when the server sent no Content-Length — a brotli response has none —
          // and it only flips to the real figure at completion. Record that as the record's -1
          // "unknown" rather than a false zero.
          size: dl.getTotalBytes() > 0 ? dl.getTotalBytes() : -1,
          resume: {
            urlChain: dl.getURLChain(),
            mimeType: dl.getMimeType(),
            eTag: dl.getETag(),
            lastModified: dl.getLastModifiedTime(),
            // Chromium rejects a fractional startTime.
            startTimeSec: Math.floor(dl.getStartTime()),
            // Chromium's own 0-means-unknown convention, NOT the record's -1. Keeping them
            // apart matters: a -1 here would sail past a `totalBytes > 0` check and go back to
            // Chromium as `length: -1`.
            totalBytes: dl.getTotalBytes(),
            receivedBytes: 0,
          },
        });
      };

      const onAbort = (): void => {
        // `done` fires synchronously inside `cancel()`, so the settle happens on the way
        // through this call. An item Chromium has already finished with may refuse it.
        if (item) {
          try {
            item.cancel();
          } catch {
            /* already finished; the `done` handler has it */
          }
          return;
        }
        // A recipe may be mid-step. The settle below does not wait for it, but leaving the step
        // to discover the cancellation on its own deadline keeps a dead window alive for it.
        bridge.abandon?.('was abandoned because the download was cancelled');
        // Nothing has started, so nothing will ever end this wait but us.
        const done = signal.reason === STALLED ? settleStalled(partial) : settleCancelled();
        void done.then(resolve, resolve);
      };
      detachAbort = (): void => { signal.removeEventListener('abort', onAbort); };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        if (plan.kind === 'resume') {
          const onResume = (_e: Event, dl: DownloadItem): void => {
            // The tripwire. The synchronous emission this correlation rests on is undocumented
            // — 10/10 reproducible, but undocumented — and it is also what guarantees no other
            // item can reach this listener. If the path disagrees, the assumption broke: refuse
            // the item rather than write someone else's bytes into our file. It is left alone
            // rather than cancelled, because cancelling deletes a partial that may not be ours.
            const got = dl.getSavePath();
            if (got !== part) {
              log.error('a resumed download item arrived with an unexpected save path', {
                id,
                expected: part,
                got,
              });
              return;
            }
            adopt(dl);
            // A resumed item is born `interrupted` and does nothing at all until this call.
            dl.resume();
          };

          // ARM, THEN CALL, WITH NOTHING IN BETWEEN. The emission is synchronous inside the
          // call, so this one-shot sees that call's own item and no other. An `await` here —
          // any await — would break the only correlation this path has.
          ses.once('will-download', onResume);
          try {
            // No `setSavePath` on this path: the `path` option stands on its own, no Save As
            // dialog appears, and `getSavePath()` is already populated in the handler above.
            ses.createInterruptedDownload({ path: part, ...plan.args });
          } finally {
            // A no-op when it fired (a `once` removes itself); the leak-stopper when it did not.
            ses.removeListener('will-download', onResume);
          }

          if (!item) {
            // Either the emission was not synchronous after all, or the tripwire refused the
            // item. Both mean we hold no item and nothing else will ever settle this record.
            log.error('a resume produced no download item', { id });
            void finish(
              failedPatch('network', 'the browser did not produce a download item to resume'),
            ).then(resolve, resolve);
          }
          return;
        }

        const onWillDownload = (_e: Event, dl: DownloadItem, from: WebContents): void => {
          // The ONLY reliable correlation on this path. `from` is `null` for any resume in
          // flight, and another job's window for any sibling, so both fall out here.
          if (from !== ownWebContents) return;
          // MUST be synchronous. With no save path Chromium opens a native modal Save As dialog
          // and the download never completes — fatal for a daemon. Measured: synchronous, a
          // microtask and `setTimeout(0)` all work; `setTimeout(300)` is silently ignored and
          // hangs. So this comes first, even in the give-up case below, where it is what stops
          // a late arrival raising a dialog nobody will ever click.
          dl.setSavePath(part);
          if (settled) {
            // The no-start timer already gave up on this download; do not resurrect the record.
            dl.cancel();
            return;
          }
          ses.removeListener('will-download', onWillDownload);
          adopt(dl);
          recordHeaders(dl);
        };
        detachWillDownload = (): void => { ses.removeListener('will-download', onWillDownload); };
        ses.on('will-download', onWillDownload);

        /**
         * Ask for the file, and start bounding the request phase at the same moment.
         *
         * A host that accepts the socket and then says nothing never fires `will-download` at
         * all — measured at 150s with no timeout, no error and nothing to cancel. That timer is
         * the only thing that ends it. The idle watchdog would eventually fire too — it seeds
         * its clock unconditionally, so it does not need `received` to have moved — but this
         * timer is a tighter bound and, unlike a stall, it names the fault: nothing ever began.
         *
         * On a recipe it is armed AFTER the steps, not in front of them, and that placement is
         * deliberate. The recipe has budgets of its own; counting a page's polling against a
         * window that measures the request phase would, at the defaults, have a 60s recipe race
         * a 60s no-start window and report "the download never started" about a recipe that was
         * still working.
         */
        const startDownload = (url: string): void => {
          noStart = setTimeout(() => {
            if (item) return; // it started; the idle watchdog owns it from here
            log.warn('download never started', { id, noStartMs: deps.noStartMs });
            void finish(
              failedPatch(
                'network',
                `the download never started within ${deps.noStartMs}ms`,
              ),
            ).then(resolve, resolve);
          }, deps.noStartMs);
          noStart.unref?.();

          // The referer the caller gave us, for a host that checks it. Page content never
          // reaches this: it is a header value, not script and not a path. A recipe never has
          // one — the browser sets its own by navigating to `startUrl`.
          ownWebContents!.downloadURL(
            url,
            rec.referer ? { headers: { referer: rec.referer } } : undefined,
          );
        };

        const run = deps.recipe;
        if (!run) {
          startDownload(rec.url);
          return;
        }

        const wc = ownWebContents!;
        const failRecipe = (message: string): void => {
          log.warn('recipe failed', { id, startUrl: run.recipe.startUrl, reason: message });
          void finish(failedPatch('recipe-failed', message)).then(resolve, resolve);
        };

        /**
         * Send one step to the page and await its answer, **racing that answer against the
         * step's own deadline**.
         *
         * `runRecipe` measures time between steps and nothing at all during one, and says so:
         * it holds no timer that could cancel a promise it did not create, so a `send` that
         * never settles hangs the recipe past every deadline in that module, forever, holding
         * a download slot. A preload that fails to load produces exactly that — measured — so
         * the timer below is not belt-and-braces, it is the only bound there is.
         *
         * The loser of the race is DROPPED, never thrown: a reply that arrives after the
         * timeout finds the step already settled and is ignored, because rejecting it would
         * surface as an unhandled rejection out of a `void`ed job path.
         */
        let seq = 0;
        const send = (step: RecipeStep, deadlineMs: number): Promise<StepResult> =>
          new Promise<StepResult>((resolveStep) => {
            const mine = ++seq;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let answered = false;

            /** First answer wins. Everything after it — a late reply included — is dropped. */
            const settleStep = (result: StepResult): void => {
              if (answered) return;
              answered = true;
              if (timer !== undefined) clearTimeout(timer);
              run.ipc.removeListener(RESULT_CHANNEL, onResult);
              bridge.abandon = null;
              resolveStep(result);
            };

            /**
             * `(seq, result)` — the reply shape the preload sends, filtered twice.
             *
             * On the SENDER first: `ipcMain` is process-wide, so every concurrent recipe
             * window answers on this one channel and a sibling's reply would otherwise be read
             * as ours — a job settling on another job's derived URL, which is not something an
             * operator could ever diagnose from a log line. Two recipe downloads running at
             * once is ordinary, so this filter is load-bearing today; the two-window test in
             * `test/unit/recipe-bridge.test.ts` is what holds it.
             *
             * Then on the SEQUENCE, which is defence in depth rather than a live guard. The
             * hazard it describes — a reply arriving after its own step timed out, handed to
             * the NEXT step as if it were about that step's selector — is unreachable as the
             * code stands: a timed-out step settles `{ ok: false }` and `runRecipe` returns on
             * the first non-ok result, so there is no later step for a stale reply to land on.
             * It stays because that unreachability rests entirely on one decision in
             * `runRecipe`; a step timeout that ever stopped being fatal would make a stale
             * reply readable as the next step's answer, silently. What the check does earn
             * today is the narrower half of the same rule, which `test/unit/recipe-bridge.test.ts`
             * pins: a late reply for an already-settled step is dropped rather than thrown.
             */
            const onResult = (event: { sender: { id: number } }, ...args: unknown[]): void => {
              if (event.sender.id !== wc.id) return;
              if (args[0] !== mine) return;
              settleStep(args[1] as StepResult);
            };

            run.ipc.on(RESULT_CHANNEL, onResult);
            timer = setTimeout(() => {
              settleStep({
                ok: false,
                error: bridge.failure
                  ?? `got no answer from the page bridge within ${run.stepMs}ms`,
              });
            }, Math.max(0, deadlineMs - Date.now()) + BRIDGE_GRACE_MS);
            // A step's timer must never be the reason a daemon stays alive on the way out.
            timer.unref?.();

            // Already known dead: do not spend a whole step deadline rediscovering it.
            if (bridge.failure !== null) { settleStep({ ok: false, error: bridge.failure }); return; }
            bridge.abandon = (why) => { settleStep({ ok: false, error: why }); };

            try {
              // `(seq, step, deadline)` — the outbound shape the preload's handler destructures.
              // The step crosses as STRUCTURED DATA: no caller string is ever built into code.
              wc.send(STEP_CHANNEL, mine, step, deadlineMs);
            } catch (e: unknown) {
              settleStep({ ok: false, error: `could not be sent to the page (${e instanceof Error ? e.message : String(e)})` });
            }
          });

        void (async (): Promise<void> => {
          try {
            try {
              await wc.loadURL(run.recipe.startUrl);
            } catch (e: unknown) {
              // Chromium rejects with ERR_NAME_NOT_RESOLVED and friends. The page never came
              // up, so no step could have run — say that rather than blaming a selector.
              if (!settled) {
                failRecipe(`could not load ${run.recipe.startUrl} (${e instanceof Error ? e.message : String(e)})`);
              }
              return;
            }
            if (settled) return;

            const derived = await runRecipe(run.recipe, {
              send,
              stepMs: run.stepMs,
              totalMs: run.totalMs,
              now: () => Date.now(),
            });

            // ENDING TWO, and it is checked FIRST — before the recipe's own verdict. A `click`
            // that started the download itself makes that item the result; the step it was in
            // the middle of was abandoned rather than completed, so `derived` is an error here
            // and reporting it would fail a job whose bytes are already arriving.
            if (item) return;
            if (settled || signal.aborted) return;

            if (isRecipeError(derived)) { failRecipe(derived.message); return; }

            /**
             * `getAttribute` returns the attribute verbatim, and a site's download link is as
             * likely to read `/download/12345` as it is to be absolute. Resolve it against the
             * page it was read off, which is what the browser itself would do with that href.
             *
             * This cannot widen the gate below. An absolute value keeps its own scheme —
             * `file:///C:/Windows/win.ini` resolves to itself — and a relative one can only
             * inherit http(s) from a page we navigated to. Everything still goes through
             * `validateTarget` either way.
             */
            const base = wc.getURL() || run.recipe.startUrl;
            let absolute = derived.url;
            try { absolute = new URL(derived.url, base).href; } catch { /* validateTarget names it */ }

            // THE DERIVED URL IS HOSTILE INPUT. It came off a page's attribute, so it is a
            // caller-and-site-controlled string, and `file:///C:/Windows/win.ini` parses
            // perfectly. `runRecipe` returns it unvalidated on purpose so this gate cannot be
            // skipped by accident — do not move it up into that module.
            const derivedTarget = validateTarget(absolute, undefined);
            if (isTargetError(derivedTarget)) {
              failRecipe(`the recipe derived a URL we will not fetch: ${derivedTarget.message}`);
              return;
            }

            log.info('recipe derived a download URL', { id, startUrl: run.recipe.startUrl });
            startDownload(derivedTarget.url);
          } catch (e: unknown) {
            // Nothing may escape this IIFE: it is detached from the promise the outer
            // try/catch guards, so a throw here is an unhandled rejection in a daemon.
            if (settled) return;
            failRecipe(`the recipe could not be run (${e instanceof Error ? e.message : String(e)})`);
          }
        })();
      } catch (e: unknown) {
        // A start call that threw. If it managed to hand us an item first, cancel it so
        // Chromium is not left transferring bytes into a record we are about to fail.
        if (item) {
          try {
            item.cancel();
          } catch {
            /* nothing to stop */
          }
        }
        const error = failureOf(e);
        log.warn('could not start the download', { id, ...error });
        void finish(failedPatch(error.code, error.message)).then(resolve, resolve);
      }
    });
  } catch (e: unknown) {
    // Nothing inside the wait above can reject — every settle path resolves — so this catches
    // the surrounding work: an unusable id, a partition or window that could not be made.
    const error = failureOf(e);
    log.warn('download through the browser failed', { id, ...error });
    await finish(failedPatch(error.code, error.message));
  } finally {
    if (noStart !== undefined) clearTimeout(noStart);
    detachAbort?.();
    detachPreloadError?.();
    // A step still in flight would otherwise hold its `ipcMain` listener until its own deadline,
    // on a window that is about to be destroyed.
    bridge.abandon?.('was abandoned because the download finished');
    // The window is destroyed while the session listener is still attached, so a download it
    // somehow starts on the way out still gets a save path instead of a modal dialog.
    if (win && !win.isDestroyed()) win.destroy();
    detachWillDownload?.();
  }
}
