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
  if (meta.urlChain.length === 0) {
    return { kind: 'restart', reason: 'no url chain was recorded' };
  }
  // `>=`, not `>`: a partial that already reaches the claimed size has nothing left to fetch,
  // and asking Chromium to continue from `offset === length` gets a 416 and an interrupted
  // download. We cannot simply finalise it either — the bytes are unverified — so start over.
  if (meta.totalBytes > 0 && partialBytes >= meta.totalBytes) {
    return { kind: 'restart', reason: 'the partial is already at or larger than the claimed size' };
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
