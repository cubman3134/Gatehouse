# Gatehouse Increment 2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/gh/fetch` actually download from a challenge-protected host, by moving the transfer onto the browser's own download stack.

**Architecture:** `net.request` is removed from the download path entirely. A download is issued by `webContents.downloadURL` on a hidden window dedicated to that one job, caught in `session.on('will-download')`, and written by Chromium to a path we set synchronously. The store, the record, retention, `/gh/*` and Range serving are unchanged — only the thing that moves bytes is replaced.

**Tech Stack:** TypeScript, ESM, Electron 43, Vitest. No new runtime dependencies.

## Why this increment exists

Live verification of increment 2 against a real Cloudflare-protected file, on one partition, immediately after a successful solve with a valid `cf_clearance` present:

| how the bytes were requested | result |
|---|---|
| `net.request({session})` | 403 — 5,851 bytes of interstitial |
| `net.request({session, useSessionCookies: true})` | 403 |
| `net.request({session, credentials: 'include'})` | 403 |
| `net.request` + the window's exact `User-Agent` | 403 |
| `webContents.downloadURL` → `will-download` | **completed, 10,759,939 bytes of real content** |

Cloudflare distinguishes the `net` client from the renderer even with the same partition, cookie and User-Agent. The design's "normal path" does not work for the sources this product exists to serve, and its "escape hatch" is the only one that does.

**Explicitly not pursued:** hand-forging Chrome's header set onto `net.request`. That is fingerprint-mimicry, which this project rules out, and it breaks whenever Cloudflare retunes.

## Measured facts this plan is built on

All from the spike; do not re-derive them, and do not assume anything beyond them.

1. **Correlation.** `will-download` fires on the *session*. With concurrent downloads, `getURL()`, `getURLChain()`, `getFilename()`, `getMimeType()`, `getETag()` and `getTotalBytes()` are all identical for the same URL, and **fire order is not call order** (calls a,b,c fired b,c,a). The only usable discriminator is the handler's third argument, the `webContents`. **Therefore: one dedicated hidden window per in-flight download.**
2. `session.downloadURL` exists and works with zero windows, but passes `webContents: null` — unusable for correlation.
3. One hidden window served 6 concurrent downloads correctly, and a download survives `win.destroy()`. A window mid-navigation is undisturbed. But (1) still forces one window per job.
4. **No `setSavePath` opens a native modal Save As dialog** (Win32 class `#32770`) and the download never completes. `session.setDownloadPath()` does not suppress it. Synchronous, microtask and `setTimeout(0)` all work; `setTimeout(300)` was silently ignored and hung. **Treat setSavePath as synchronous-required.**
5. **Cancel:** `done` fires synchronously inside `cancel()`, `getReceivedBytes()` resets to 0, and **Chromium deletes the partial** — including for a paused item.
6. `getState()` reports `"progressing"` while paused; only `isPaused()` is truthful.
7. **Progress:** reliable with `Content-Length`. Without it — which is the real host, because brotli — `getTotalBytes()` is `0` throughout and `getPercentComplete()` is `-1`, both flipping to real values only at completion.
8. **404:** `will-download` *does* fire, then `interrupted`, 0 bytes, no file. **The HTTP status is not exposed anywhere on the item.**
9. **Silent host:** `will-download` **never fires**, no timeout in 150s, nothing to cancel, `closeAllConnections()` does not help. **Gatehouse must own the timer.**
10. **Connection refused:** the item fires and then never settles; only an explicit `cancel()` ends it.
11. **Restart:** nothing survives. There is no enumeration API on `Session` and no `will-download` on startup. The partial file *does* survive a SIGKILL. To resume we must persist `urlChain`, `savePath`, `mimeType`, `eTag`, `lastModified`, `startTime` (floored to integer seconds), `totalBytes`, `receivedBytes` ourselves.
12. **Chromium validates resume *length* but never *content*.** A wrong-content partial resumes to `completed` and corrupt.
13. With no `eTag` and no `lastModified`, `createInterruptedDownload` **silently restarts at byte 0 while `canResume()` still returns true**. The real host provides neither.

## Global Constraints

- Node >= 22.12.0, Electron pinned `43.4.1`, TypeScript, ESM, Vitest. Relative imports carry a `.js` extension.
- `npm test` stays `tsc && vitest run`.
- **No AI attribution in commits.** Conventional prefixes.
- **`/v1`'s request/response shapes, statuses and auth model are untouchable.** Increment 1 is live in production against a real rig.
- **`/gh/*`'s wire contract does not change**: same paths, same `202 {jobId,state}`, same `{state,progress,result?,error?}`, same `{"error":{"code","message"}}`, same statuses. This increment changes only how bytes are moved.
- The store, `record.ts`, retention, `resume.ts`'s startup re-queue, `range.ts` and `gh.ts` are **not** rewritten.
- **A record settles only after its writer has released the file.** Chromium is the writer now; its `done` event is the release.
- No promise rejection may escape into a `void`ed call site.

## The safety rule this increment must not lose

Increment 2's transfer refused any body it could not place correctly — a 200 answering a Range request, a 206 from a third offset, a 206 with no `content-range`. Chromium now owns range handling, and per fact 12 it will happily resume a wrong-content partial to `completed`.

**So: only resume a partial when we hold a validator for it.** If the record has an `eTag` or a `lastModified`, pass it to `createInterruptedDownload` — Chromium sends `If-Range` and the server restarts the transfer itself if it no longer matches. If we hold neither, **do not resume: delete the partial and start from zero.** That is both safe and honest, and per fact 13 it is what Chromium would silently do anyway.

## File Structure

| Path | Responsibility |
|---|---|
| `src/downloads/browser.ts` | The whole browser-download flow: window per job, `will-download` correlation, sync save path, progress, cancel, both timeouts, settle. |
| `src/downloads/resumable.ts` | Pure: is this record resumable, and what does `createInterruptedDownload` need? |
| `src/downloads/record.ts` | *(modify)* add the persisted resume metadata |
| `src/main.ts` | *(modify)* wire `browserDownload` in place of `transfer` + `electronRequester` |
| `src/downloads/transfer.ts`, `test/unit/transfer.test.ts` | *(delete)* superseded — see Task 4 |
| `test/integration/browser-download.test.ts` | End-to-end through the real app against the local file host |

---

### Task 1: Resume metadata and the resume decision

**Files:**
- Create: `src/downloads/resumable.ts`
- Modify: `src/downloads/record.ts`
- Test: `test/unit/resumable.test.ts`

**Interfaces:**
- Consumes: `DownloadRecord` (existing)
- Produces:
  - `DownloadRecord` gains `resume?: { urlChain: string[]; mimeType: string; eTag: string; lastModified: string; startTimeSec: number; totalBytes: number; receivedBytes: number }`
  - `interface ResumePlan { kind: 'resume'; args: ResumeArgs } | { kind: 'restart'; reason: string }`
  - `function planResume(rec: DownloadRecord, partialBytes: number): ResumePlan`

- [ ] **Step 1: Write the failing test**

Create `test/unit/resumable.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planResume } from '../../src/downloads/resumable.js';
import type { DownloadRecord } from '../../src/downloads/record.js';

const rec = (over: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id: 'd1', url: 'https://h.test/f.bin', session: 'h.test', referer: null,
  suggestedName: 'f.bin', contentType: 'application/octet-stream',
  size: 100, received: 40, sha256: null, state: 'failed',
  createdAt: 1000, completedAt: 2000, lastAccessAt: 2000, ...over,
});

const full = {
  urlChain: ['https://h.test/f.bin'], mimeType: 'application/octet-stream',
  eTag: '"abc"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
  startTimeSec: 1_700_000_000, totalBytes: 100, receivedBytes: 40,
};

describe('planResume', () => {
  it('resumes when a validator and a partial are both present', () => {
    const p = planResume(rec({ resume: full }), 40);
    expect(p.kind).toBe('resume');
    if (p.kind === 'resume') {
      expect(p.args.offset).toBe(40);
      expect(p.args.eTag).toBe('"abc"');
      expect(p.args.urlChain).toEqual(['https://h.test/f.bin']);
    }
  });

  it('resumes on lastModified alone', () => {
    const p = planResume(rec({ resume: { ...full, eTag: '' } }), 40);
    expect(p.kind).toBe('resume');
  });

  it('resumes on eTag alone', () => {
    const p = planResume(rec({ resume: { ...full, lastModified: '' } }), 40);
    expect(p.kind).toBe('resume');
  });

  // THE SAFETY RULE. Chromium validates a resume's LENGTH but never its CONTENT, so without a
  // validator it would append to — or silently restart over — bytes it cannot vouch for.
  it('restarts when there is no validator at all', () => {
    const p = planResume(rec({ resume: { ...full, eTag: '', lastModified: '' } }), 40);
    expect(p.kind).toBe('restart');
    if (p.kind === 'restart') expect(p.reason).toMatch(/validator/i);
  });

  it('restarts when the record carries no resume metadata', () => {
    const p = planResume(rec(), 40);
    expect(p.kind).toBe('restart');
  });

  it('restarts when there is no partial on disk', () => {
    expect(planResume(rec({ resume: full }), 0).kind).toBe('restart');
  });

  it('restarts when the partial is larger than the file claimed to be', () => {
    const p = planResume(rec({ resume: full }), 500);
    expect(p.kind).toBe('restart');
    if (p.kind === 'restart') expect(p.reason).toMatch(/larger/i);
  });

  it('uses the ACTUAL partial size as the offset, not the recorded counter', () => {
    // The recorded counter is throttled and can lag; the file on disk is the truth.
    const p = planResume(rec({ resume: { ...full, receivedBytes: 12 } }), 40);
    if (p.kind === 'resume') expect(p.args.offset).toBe(40);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/resumable.test.ts`
Expected: FAIL — cannot resolve `../../src/downloads/resumable.js`

- [ ] **Step 3: Add the metadata to `src/downloads/record.ts`**

```ts
/**
 * What `session.createInterruptedDownload` needs to pick a transfer back up. Chromium keeps
 * none of this across a restart — there is no enumeration API and no `will-download` on
 * startup — so we persist it ourselves or resume is impossible.
 */
export interface ResumeMetadata {
  urlChain: string[];
  mimeType: string;
  /** Empty when the server sent none. */
  eTag: string;
  /** Empty when the server sent none. */
  lastModified: string;
  /** Floored to integer seconds — Chromium rejects a fractional startTime. */
  startTimeSec: number;
  /** 0 when the server sent no Content-Length. */
  totalBytes: number;
  receivedBytes: number;
}
```

and add to `DownloadRecord`:

```ts
  /** Present once a transfer has started and reported its headers. */
  resume?: ResumeMetadata;
```

- [ ] **Step 4: Implement `src/downloads/resumable.ts`**

```ts
import type { DownloadRecord, ResumeMetadata } from './record.js';

export interface ResumeArgs {
  path: string;
  urlChain: string[];
  mimeType: string;
  offset: number;
  length: number;
  lastModified: string;
  eTag: string;
  startTime: number;
}

export type ResumePlan =
  | { kind: 'resume'; args: Omit<ResumeArgs, 'path'> }
  | { kind: 'restart'; reason: string };

/**
 * Decide whether a surviving partial may be resumed.
 *
 * The rule exists because **Chromium validates a resume's length but never its content**: a
 * partial holding the wrong bytes resumes to `completed` and corrupt. An `If-Range` validator
 * is what makes the server itself refuse a mismatched continuation, so without one we do not
 * resume at all. Measured: with neither `eTag` nor `lastModified`, `createInterruptedDownload`
 * silently restarts at byte 0 while `canResume()` still reports true — so restarting
 * explicitly is also the honest description of what would happen anyway.
 *
 * `partialBytes` is the size of the file on disk, and it wins over the record's `receivedBytes`
 * counter, which is throttled and can lag.
 */
export function planResume(rec: DownloadRecord, partialBytes: number): ResumePlan {
  const meta: ResumeMetadata | undefined = rec.resume;
  if (!meta) return { kind: 'restart', reason: 'no resume metadata was recorded' };
  if (partialBytes <= 0) return { kind: 'restart', reason: 'no partial on disk' };
  if (!meta.eTag && !meta.lastModified) {
    return { kind: 'restart', reason: 'the server gave no validator (no eTag, no lastModified)' };
  }
  if (meta.totalBytes > 0 && partialBytes > meta.totalBytes) {
    return { kind: 'restart', reason: 'the partial is larger than the file claimed to be' };
  }

  return {
    kind: 'resume',
    args: {
      urlChain: meta.urlChain,
      mimeType: meta.mimeType,
      offset: partialBytes,
      length: meta.totalBytes,
      lastModified: meta.lastModified,
      eTag: meta.eTag,
      startTime: Math.floor(meta.startTimeSec),
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/resumable.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Mutation-check the safety rule**

Remove the `if (!meta.eTag && !meta.lastModified)` guard and confirm `restarts when there is no validator at all` goes RED. Restore. Report both outputs.

- [ ] **Step 7: Commit**

```bash
git add src/downloads/resumable.ts src/downloads/record.ts test/unit/resumable.test.ts
git commit -m "feat: decide when a partial may be resumed

Chromium validates a resume's length but never its content, so a partial
holding the wrong bytes resumes to completed and corrupt. An If-Range
validator is what makes the server refuse a mismatched continuation, so
without an eTag or a lastModified we restart from zero — which is also,
measurably, what Chromium would silently do anyway.

The size of the file on disk wins over the recorded counter, which is
throttled and can lag."
```

---

### Task 2: The browser download engine

**Files:**
- Create: `src/downloads/browser.ts`
- Test: covered end-to-end in Task 3 (this module cannot run without Electron)

**Interfaces:**
- Consumes: `DownloadStore`, `DownloadRecord`, `planResume`
- Produces:
  - `interface BrowserDownloadDeps { store: DownloadStore; partitionFor: (session: string) => Electron.Session; makeWindow: (session: string) => Electron.BrowserWindow; noStartMs: number; stallMs: number }`
  - `function browserDownload(id: string, deps: BrowserDownloadDeps, signal: AbortSignal): Promise<void>`
  - `const STALLED: unique symbol` — re-exported so the watchdog and the settle path agree, as `transfer.ts` did

> **Amended before implementation — the resume path needs its OWN correlation, measured.**
>
> The code below funnels both paths through one `will-download` handler keyed on the
> `webContents` argument. That is correct for `downloadURL` and **wrong for a resume.** Measured
> (10/10 across two runs):
>
> - `createInterruptedDownload` **does** fire `will-download` — **synchronously, inside the call
>   itself**; the handler runs and returns before the call returns.
> - Its third argument is **`null`**, never a `webContents`. This is structural, not incidental:
>   `createInterruptedDownload` is declared only on `Session`, while `downloadURL` exists on
>   `Session`, `WebContents` and `WebviewTag`. There is no window-scoped resume API, so the
>   argument has nothing to be. It was `null` even with two hidden windows live.
> - `setSavePath` is **not** needed on the resume path — the `path` option stands on its own, no
>   Save As dialog appears, and `item.getSavePath()` is **already populated** inside the handler
>   (on the `downloadURL` path it is `""`).
> - Concurrent resumes ARE distinguishable, by `getSavePath()` and by `getReceivedBytes()`.
>
> **So the module needs two correlation mechanisms, not one:**
>
> | path | started by | correlate on |
> |---|---|---|
> | fresh | `win.webContents.downloadURL(url)` | the handler's `webContents === win.webContents` |
> | resume | `ses.createInterruptedDownload({path, ...})` | a one-shot `ses.once('will-download', ...)` armed **immediately before** the call |
>
> Because the resume emission is synchronous, arming a `once` listener directly before the call
> captures that call's own item even when interleaved with others. **There must be no `await`
> between arming and calling** — that is the whole guarantee.
>
> Keep `item.getSavePath() === part` as an assertion on the resume path. The synchronous
> emission is not documented by Electron; it reproduced 10/10 and follows from the item being
> constructed locally, but a cheap tripwire beats relying on undocumented ordering.
>
> **A resume needs no window at all** — do not create one for it.
>
> **Store invariant to state and rely on:** two live records must never share a `path`, or their
> resume items are indistinguishable, one never settles, and the file ends up 0 bytes. Ours are
> `<id>.part` with `randomUUID` ids, so this holds by construction — say so in a comment rather
> than leaving it to luck.
>
> One more measured consequence for the fresh path: a resumed item is **born in state
> `interrupted` and does nothing until `resume()` is called on it.** The handler must call
> `item.resume()`.

- [ ] **Step 1: Implement `src/downloads/browser.ts`**

```ts
import { stat, rm, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DownloadStore } from './store.js';
import { planResume } from './resumable.js';
import { log } from '../log.js';

/** Abort reason marking a watchdog stall, so the settle path can tell it from a caller cancel. */
export const STALLED = Symbol('stalled');

export interface BrowserDownloadDeps {
  store: DownloadStore;
  partitionFor: (session: string) => Electron.Session;
  makeWindow: (session: string) => Electron.BrowserWindow;
  /** How long to wait for `will-download` to fire at all before giving up. */
  noStartMs: number;
  /** How long `receivedBytes` may sit still before the transfer is judged stalled. */
  stallMs: number;
}

/**
 * Download one record through the browser's own download stack.
 *
 * `net.request` is not used and must not be: measured against a real challenge-protected host,
 * every `net.request` variant was refused 403 while holding a valid clearance in the same
 * partition, and only `downloadURL` succeeded. Cloudflare tells the `net` client from the
 * renderer.
 *
 * **One window per job, and that is not a style choice.** `will-download` fires on the session,
 * and for concurrent downloads of the same URL every field on the item — url, urlChain,
 * filename, mime, eTag, totalBytes — is identical, with fire order not matching call order. The
 * handler's `webContents` argument is the only discriminator there is.
 *
 * Never rejects: a rejection here would reach a `void`ed call site and take the daemon down.
 */
export async function browserDownload(
  id: string,
  deps: BrowserDownloadDeps,
  signal: AbortSignal,
): Promise<void> {
  const rec = deps.store.get(id);
  if (!rec) return;

  const part = deps.store.partPath(id);
  const ses = deps.partitionFor(rec.session);

  let partial = 0;
  try { partial = (await stat(part)).size; } catch { /* none */ }
  const plan = planResume(rec, partial);
  if (plan.kind === 'restart' && partial > 0) {
    log.info('not resuming this partial, starting over', { id, reason: plan.reason, discarded: partial });
    await rm(part, { force: true });
    partial = 0;
  }

  await deps.store.update(id, { state: 'running' });

  const win = deps.makeWindow(rec.session);
  let item: Electron.DownloadItem | null = null;
  let settled = false;

  const finish = async (patch: Parameters<DownloadStore['update']>[1]) => {
    if (settled) return;
    settled = true;
    await deps.store.update(id, patch);
  };

  try {
    await new Promise<void>((resolve) => {
      const onWillDownload = (
        event: Electron.Event,
        dl: Electron.DownloadItem,
        wc: Electron.WebContents,
      ) => {
        // The ONLY reliable correlation. Anything else matches a sibling job on the same URL.
        if (wc !== win.webContents) return;
        ses.removeListener('will-download', onWillDownload);
        item = dl;

        // MUST be synchronous. With no save path Chromium opens a native modal Save As dialog
        // and the download never completes — fatal for a daemon. Measured: sync, a microtask
        // and setTimeout(0) all work; setTimeout(300) is silently ignored and hangs.
        dl.setSavePath(part);

        void deps.store.update(id, {
          suggestedName: dl.getFilename() || null,
          contentType: dl.getMimeType() || null,
          // 0 when the server sent no Content-Length — brotli responses have none. Report it
          // as the record's -1 "unknown" rather than a false zero.
          size: dl.getTotalBytes() > 0 ? dl.getTotalBytes() : -1,
          resume: {
            urlChain: dl.getURLChain(),
            mimeType: dl.getMimeType(),
            eTag: dl.getETag() ?? '',
            lastModified: dl.getLastModifiedTime() ?? '',
            startTimeSec: Math.floor(dl.getStartTime()),
            totalBytes: dl.getTotalBytes(),
            receivedBytes: 0,
          },
        });

        let lastSeen = -1;
        dl.on('updated', () => {
          const got = dl.getReceivedBytes();
          if (got !== lastSeen) { lastSeen = got; void deps.store.update(id, { received: got }); }
        });

        dl.once('done', (_e, state) => {
          clearTimeout(noStart);
          void (async () => {
            if (state === 'completed') {
              const sha256 = await hashFile(part).catch(() => null);
              const size = await stat(part).then((s) => s.size).catch(() => -1);
              await rename(part, deps.store.filePath(id)).catch(() => undefined);
              const now = deps.store.nowMs();
              await finish({
                state: 'done', received: size, size, sha256,
                completedAt: now, lastAccessAt: now,
              });
            } else if (signal.reason === STALLED) {
              // Chromium deletes the partial on cancel, so a stall cannot leave one to resume.
              await finish({
                state: 'failed', completedAt: deps.store.nowMs(),
                error: { code: 'network', message: `no bytes arrived for ${deps.stallMs}ms` },
              });
            } else if (signal.aborted) {
              await finish({
                state: 'cancelled', completedAt: deps.store.nowMs(),
                error: { code: 'cancelled', message: 'cancelled by the caller' },
              });
            } else {
              // `state` is 'interrupted' or 'cancelled'. The HTTP status is not exposed
              // anywhere on the item, so there is no code to report beyond this.
              await finish({
                state: 'failed', completedAt: deps.store.nowMs(),
                error: { code: 'network', message: `the download ${state}` },
              });
            }
            resolve();
          })();
        });
      };

      ses.on('will-download', onWillDownload);

      // A host that accepts the socket and then says nothing never fires `will-download` at
      // all — measured at 150s with no timeout and nothing to cancel. This timer is the only
      // thing that ends that.
      const noStart = setTimeout(() => {
        if (item) return;
        ses.removeListener('will-download', onWillDownload);
        void finish({
          state: 'failed', completedAt: deps.store.nowMs(),
          error: { code: 'network', message: `the download never started within ${deps.noStartMs}ms` },
        }).then(resolve);
      }, deps.noStartMs);
      noStart.unref?.();

      const onAbort = () => { item?.cancel(); };
      signal.addEventListener('abort', onAbort, { once: true });

      if (plan.kind === 'resume') {
        ses.createInterruptedDownload({ path: part, ...plan.args });
      } else {
        win.webContents.downloadURL(rec.url);
      }
    });
  } catch (e: unknown) {
    await finish({
      state: 'failed', completedAt: deps.store.nowMs(),
      error: { code: 'network', message: e instanceof Error ? e.message : String(e) },
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Uint8Array);
  return h.digest('hex');
}
```

- [ ] **Step 2: Confirm it compiles**

Run: `npx tsc --noEmit`
Expected: exit 0. If `Electron.DownloadItem` types are unavailable without importing `electron`, import the types only (`import type { Session, BrowserWindow, DownloadItem, WebContents } from 'electron'`) — a type-only import does not pull Electron into the module graph at runtime.

- [ ] **Step 3: Commit**

```bash
git add src/downloads/browser.ts
git commit -m "feat: download through the browser's own stack

Measured against a real challenge-protected host: every net.request variant was
refused 403 while holding a valid clearance in the same partition, and only
downloadURL succeeded — Cloudflare tells the net client from the renderer.

One window per job is forced, not stylistic: will-download fires on the session
and every field on the item is identical for concurrent downloads of one URL,
with fire order not matching call order. The webContents argument is the only
discriminator there is.

The save path is set synchronously because without one Chromium opens a native
modal Save As dialog and the download never completes."
```

---

### Task 3: Wire it in, delete the `net.request` path, and prove it end to end

**Files:**
- Modify: `src/main.ts`, `src/config.ts`, `README.md`
- Delete: `src/downloads/transfer.ts`, `test/unit/transfer.test.ts`
- Modify: `test/fixture/filehost.ts` (keep — Task 3's integration test uses it)
- Create: `test/integration/browser-download.test.ts`

**Interfaces:**
- Produces: `GatehouseConfig` gains `downloadNoStartMs` (default 60000, range 5000–600000). `downloadStallMs` already exists.

- [ ] **Step 1: Add the setting**

In `src/config.ts`, beside the existing download settings:

```ts
  /** How long to wait for a download to begin at all before giving up. */
  downloadNoStartMs: number;
```

```ts
    downloadNoStartMs: intFrom(env.GATEHOUSE_DOWNLOAD_NO_START_MS, 60_000, 'GATEHOUSE_DOWNLOAD_NO_START_MS', 5_000, 600_000),
```

Add tests to `test/unit/config.test.ts` for the default, both boundaries accepted, and both just-past-boundary values rejected — matching the shape of the existing download-setting tests.

- [ ] **Step 2: Rewire `src/main.ts`**

Replace the `electronRequester` + `transfer` wiring with `browserDownload`. The queue's `run` becomes:

```ts
    run: async (id) => {
      const ac = aborts.get(id) ?? new AbortController();
      aborts.set(id, ac);
      const watchdog = startStallWatchdog(id, ac, store, cfg.downloadStallMs);
      try {
        await browserDownload(id, {
          store,
          partitionFor: (name) => electronSession.fromPartition(`persist:${name}`),
          makeWindow: (name) => new BrowserWindow({
            show: false,
            webPreferences: {
              partition: `persist:${name}`,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          }),
          noStartMs: cfg.downloadNoStartMs,
          stallMs: cfg.downloadStallMs,
        }, ac.signal);
      } finally {
        clearInterval(watchdog);
        aborts.delete(id);
        await store.sweep();
      }
    },
```

Keep the existing stall watchdog, but have it `ac.abort(STALLED)` importing `STALLED` from `browser.js` rather than `transfer.js`.

Delete `electronRequester` entirely, and the `net` import if nothing else uses it.

- [ ] **Step 3: Delete the superseded module**

```bash
git rm src/downloads/transfer.ts test/unit/transfer.test.ts
```

`transfer.ts` implemented range handling that Chromium now owns, and `nodeRequester` existed to test it. Keeping a second, production-dead download path is complexity with no reader. Its corruption guards are superseded by the resume rule in `resumable.ts`, which is where that safety now lives.

`test/fixture/filehost.ts` stays — the integration test still needs a local host.

- [ ] **Step 4: Write the integration test**

Create `test/integration/browser-download.test.ts`. Model it on the existing `test/integration/download.test.ts`, which should be kept and updated where it referenced transfer-specific behaviour. Cover, through the real spawned app against `startFileHost`:

1. A download completes: `202` → poll `done` → correct `sha256` → `result.path` exists at the right size.
2. The bytes serve back whole, and a `Range` request returns `206` with the exact `Content-Range` and byte-equal slice.
3. Two **concurrent** downloads of the **same URL** both complete correctly with distinct job ids and correct hashes. This is the correlation property — with a single shared window it would fail, so it is the regression net for the one-window-per-job rule.
4. A `chunked` (no `Content-Length`) download completes, and `progress.total` reads `-1` rather than `0` while it runs.
5. A cancel settles `cancelled` and leaves no `.part`.
6. A `no-headers` host fails `network` within the configured `noStartMs` rather than hanging — run the app with a short `GATEHOUSE_DOWNLOAD_NO_START_MS`.
7. `DELETE` on a completed job releases the bytes.

- [ ] **Step 5: Build and run**

```bash
npx tsc
npx vitest run test/integration/browser-download.test.ts
```

Then the full suite: `npm test`.

- [ ] **Step 6: Update the README**

Replace the "Live verification, 2026-08-22" section's closing ("treat it as unfinished until the browser-initiated path lands") with what actually shipped. State plainly:

- downloads go through the browser's own stack, and why `net.request` is not used;
- one hidden window per in-flight download, and why;
- a download resumes **only** when the server gave an `eTag` or a `Last-Modified`, and restarts from zero otherwise — including that the measured real host gives neither, so **for that host resume is a re-download**;
- `progress.total` is `-1` for a server that sends no `Content-Length`, which includes any brotli response;
- a failure carries no HTTP status because Chromium does not expose one on the item.

Do not claim the multi-GB case or any content source has been exercised.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: move downloads onto the browser stack and delete the net.request path

net.request cannot fetch from a challenge-protected host even holding a valid
clearance, so the path it served is gone rather than left as a second,
production-dead implementation. The range handling it did is Chromium's now,
and the safety it provided lives in the resume rule instead.

The integration test downloads the same URL twice concurrently, which is the
regression net for one-window-per-job: with a shared window the two jobs are
indistinguishable in will-download."
```

---

### Task 4: Live verification

**Files:** none — this task produces a report, and whatever fix its findings demand.

This is the task increment 2 skipped and then failed. It is not optional and it is not a formality: the last two increments each had a green suite that meant nothing against a real host.

- [ ] **Step 1: Build and deploy**

```bash
npm run build
```

Restart the running instance through its Startup launcher (`…\Start Menu\Programs\Startup\Gatehouse.vbs`) via WMI `Win32_Process.Create`, so what is tested is what boots.

- [ ] **Step 2: Regress `/v1` first**

Solve a fresh session against the real challenge-protected host and confirm `status: ok`, a `cf_clearance` cookie and a non-empty `userAgent`. **If this fails, stop** — increment 1 is live and a regression there matters more than anything in this increment.

- [ ] **Step 3: Download through the solved session**

`POST /gh/fetch` for the same URL and session. Poll to `done`. Confirm:
- the state reaches `done`, not `failed`;
- `result.path` exists on disk at the reported size;
- the file's first bytes are the real content, not a challenge interstitial;
- `sha256` is present and matches an independent hash of the file on disk.

- [ ] **Step 4: Serve it back**

`GET /gh/files/:id` whole, then with `Range: bytes=100-199`. Confirm `206`, the exact `Content-Range`, and a byte-equal slice.

- [ ] **Step 5: Release it**

`DELETE /gh/jobs/:id`, confirm `204`, then a `404` and the file gone from disk.

- [ ] **Step 6: Report honestly**

Record what worked and what did not, in the README and in the progress ledger. **If any step fails, that is the finding** — write it down with the measurement, do not work around it.

---

## Self-Review

**Spec coverage.** The design's stated download contract is unchanged: `/gh/fetch` → `202`, poll, `path` + `url` + `sha256`, Range serving, DELETE, TTL and size-cap retention. Only the byte-mover is replaced. The two mechanisms the spec names — direct fetch and browser-initiated — collapse to one, because measurement showed the first does not work for the sources this exists to serve; the spec's Downloading section should be amended when this lands.

**What this increment gives up, deliberately.** Increment 2's transfer refused any body it could not place. Chromium now owns range handling and does not offer that. The compensating rule is `planResume`: no validator, no resume. That is weaker in one respect — we can no longer detect a lying 206 — and stronger in another, since the server itself enforces `If-Range`. It is a real trade and the README must say so.

**Type consistency.** `ResumeMetadata` is defined once in `record.ts`; `ResumeArgs`/`ResumePlan`/`planResume` once in `resumable.ts`; `STALLED` moves from `transfer.ts` to `browser.ts` and both its thrower (`main.ts`'s watchdog) and its reader (`browser.ts`'s settle) import it from there. `DownloadStore`, `DownloadRecord`, `isSettled`, `FailureCode`, `serveFile`, `handleGh`, `GhDeps` are untouched.

**One thing I could not settle from the spike, and the plan must not pretend otherwise.** Whether `createInterruptedDownload` fires `will-download` — and therefore whether the correlation handler catches a resumed download at all — was not measured. Task 2's code assumes it does. Task 3's integration test must cover a resume explicitly, and if the event does not fire, Task 2 needs a second correlation path rather than a patch.
