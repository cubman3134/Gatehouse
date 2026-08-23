import type { FailureCode, JobError } from '../jobs/queue.js';

export type DownloadState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

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
  /**
   * 0 when the server sent no Content-Length. **Chromium's convention, not ours** — the
   * record's own `size` uses -1 for the same fact. Do NOT copy one into the other: a -1
   * here sails past a `totalBytes > 0` check as "no Content-Length" and then goes to
   * Chromium as `length: -1`.
   */
  totalBytes: number;
  receivedBytes: number;
}

export interface DownloadRecord {
  /** Opaque id. This is the caller's handle and the on-disk basename — never a remote name. */
  id: string;
  url: string;
  session: string;
  referer: string | null;
  /**
   * The name the remote server suggested, for the caller's benefit ONLY. It is hostile input
   * and never touches a path: files on disk are always `<id>.part` / `<id>.bin`.
   */
  suggestedName: string | null;
  contentType: string | null;
  /** Expected total bytes, or -1 when the server did not say. */
  size: number;
  received: number;
  sha256: string | null;
  state: DownloadState;
  error?: JobError;
  createdAt: number;
  completedAt: number | null;
  /** Bumped whenever the bytes are served, so the size-cap sweep can evict least-recently-used. */
  lastAccessAt: number;
  /** Present once a download has started and its headers have been read off the item. */
  resume?: ResumeMetadata;
  /**
   * True when this record's `url` is a recipe's `startUrl` rather than the file itself.
   *
   * The recipe is **not** persisted — it is a caller's selector contract and has no business in
   * a manifest — so after a restart there is nothing left to re-derive the file URL with. This
   * flag is the one bit that survives, and it exists to stop a silent wrong answer: without it
   * a recipe record whose partial cannot be resumed would be "restarted" by downloading its
   * `url`, which is the *page*, and settle `done` holding HTML. With it, that record fails and
   * the caller re-POSTs its recipe. A boolean, not the steps.
   */
  viaRecipe?: boolean;
}

const SETTLED: ReadonlySet<DownloadState> = new Set<DownloadState>(['done', 'failed', 'cancelled']);

export function isSettled(state: DownloadState): boolean {
  return SETTLED.has(state);
}

/**
 * May a retention sweep delete this record's bytes? Only if nothing is writing them. A
 * `failed` or `cancelled` record owns at most a stale `.part`, so it is reclaimable too.
 *
 * That rests on an ordering invariant every writer must honour: **a record only becomes
 * settled once the writer has closed its file handle.** Marking `cancelled` at the moment
 * cancellation is *requested* — the natural implementation — would let a sweep unlink a file
 * the OS still has open for writing. Settle after the stream is closed, never before.
 */
export function isReclaimable(rec: DownloadRecord): boolean {
  return isSettled(rec.state);
}

export type { FailureCode };
