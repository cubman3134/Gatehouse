import type { FailureCode, JobError } from '../jobs/queue.js';

export type DownloadState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

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
}

const SETTLED: ReadonlySet<DownloadState> = new Set<DownloadState>(['done', 'failed', 'cancelled']);

export function isSettled(state: DownloadState): boolean {
  return SETTLED.has(state);
}

/**
 * May a retention sweep delete this record's bytes? Only if nothing is writing them. A
 * `failed` or `cancelled` record owns at most a stale `.part`, so it is reclaimable too.
 */
export function isReclaimable(rec: DownloadRecord): boolean {
  return isSettled(rec.state);
}

export type { FailureCode };
