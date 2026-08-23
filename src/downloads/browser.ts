import { stat, rm, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { BrowserWindow, DownloadItem, Event, Session, WebContents } from 'electron';
import type { DownloadStore } from './store.js';
import type { DownloadRecord, FailureCode } from './record.js';
import { planResume } from './resumable.js';
import { STALLED } from './stalled.js';
import { log } from '../log.js';

/**
 * The stall abort reason, re-exported so this module reads as self-contained.
 *
 * It is deliberately not minted here: it is minted once, in `stalled.ts`, and `transfer.ts`
 * re-exports that same binding. Identity is the whole mechanism and a second mint would compare
 * unequal while printing identically, so whichever engine the watchdog in `main.ts` is wired
 * to, both sides are looking at one symbol. See `stalled.ts` for why that failure is silent.
 */
export { STALLED } from './stalled.js';

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

export interface BrowserDownloadDeps {
  store: DownloadStore;
  /** The partition that solved the challenge — the cookies and fingerprint come with it. */
  partitionFor: (session: string) => Session;
  /** A hidden window on that partition, owned by this call and destroyed by it. */
  makeWindow: (session: string) => BrowserWindow;
  /** How long to wait for `will-download` to fire at all before giving up. */
  noStartMs: number;
  /** How long `receivedBytes` may sit still before the transfer is judged stalled. */
  stallMs: number;
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
   * the download *started* and a long transfer's partial could be reclaimed within minutes.
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
     * `network` — which is also what lets a re-POST reclaim the record rather than mint a new
     * id. Reporting it as `cancelled` would be a lie about who acted.
     *
     * It cannot keep its bytes, though, and that is worth knowing: the only way to end a stalled
     * browser download is `cancel()`, and Chromium deletes the partial on cancel. So unlike the
     * byte-stream transfer, a stall here leaves nothing to resume from — the reclaim finds no
     * `.part` and starts over.
     */
    const settleStalled = async (received: number): Promise<void> => {
      log.warn('download abandoned after a stall', { id, received, stallMs: deps.stallMs });
      await finish(
        failedPatch('network', `no bytes arrived within ${deps.stallMs}ms`, received),
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

    // A resume needs no window, and must not be given one — `createInterruptedDownload` is a
    // session API and would ignore it.
    if (plan.kind === 'restart') win = deps.makeWindow(rec.session);
    // Captured once. Reading `win.webContents` later, after the window is destroyed, throws
    // from inside an emit — an uncaught exception in a daemon. The reference itself stays safe
    // to compare forever.
    const ownWebContents: WebContents | null = win ? win.webContents : null;

    await new Promise<void>((resolve) => {
      /** Wire an item we have decided is ours, and settle from its `done`. */
      const adopt = (dl: DownloadItem): void => {
        item = dl;

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
                await settleStalled(0);
              } else if (signal.aborted) {
                await settleCancelled();
              } else {
                // `interrupted`, or a `cancelled` nobody here asked for. The HTTP status is not
                // exposed anywhere on the item — a 404 arrives as an interrupt with 0 bytes and
                // no file — so there is no code to report beyond this. The partial, if any, is
                // KEPT: that is what a later resume continues from.
                const received = receivedOf(dl);
                log.warn('download did not complete', { id, state, received });
                await finish(failedPatch('network', `the download ${state}`, received));
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

        // A host that accepts the socket and then says nothing never fires `will-download` at
        // all — measured at 150s with no timeout, no error and nothing to cancel. This timer is
        // the only thing that ends that. The idle watchdog would eventually fire too — it seeds
        // its clock unconditionally, so it does not need `received` to have moved — but this
        // timer is a tighter bound and, unlike a stall, it names the fault: nothing ever began.
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
        // reaches this: it is a header value, not script and not a path.
        ownWebContents!.downloadURL(
          rec.url,
          rec.referer ? { headers: { referer: rec.referer } } : undefined,
        );
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
    // The window is destroyed while the session listener is still attached, so a download it
    // somehow starts on the way out still gets a save path instead of a modal dialog.
    if (win && !win.isDestroyed()) win.destroy();
    detachWillDownload?.();
  }
}
