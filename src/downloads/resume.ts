import { stat } from 'node:fs/promises';
import type { DownloadRecord } from './record.js';
import { INTERRUPTED_BY_RESTART, type DownloadStore } from './store.js';
import { log } from '../log.js';

/**
 * Was this record demoted by `store.load()` purely because the process that owned it died?
 *
 * `load()` marks every unsettled record `failed` on the way up — a deliberate safe default,
 * because a `running` record with no process behind it must not block dedupe or sit
 * unreclaimable forever. But `failed` is settled, so `findOpen` will not return it and a
 * re-POST mints a fresh id and a fresh `.part`, orphaning the old bytes until the TTL sweep.
 * Without this predicate the resume machinery in `transfer` has no caller at all.
 *
 * The match is deliberately narrow: the code, the message and the state together. A download
 * that failed for a REAL reason — a 404, a 206 from the wrong offset, a full disk — carries a
 * different code or a different message and must never be re-queued, because the retry would
 * hit exactly the same wall and the daemon would spin on it every time it starts.
 */
export function wasInterruptedByRestart(rec: DownloadRecord): boolean {
  return rec.state === 'failed'
    && rec.error?.code === 'cancelled'
    && rec.error.message === INTERRUPTED_BY_RESTART;
}

/** Does `<id>.part` still exist, and hold something worth resuming from? */
async function hasPartial(store: DownloadStore, id: string): Promise<boolean> {
  try {
    return (await stat(store.partPath(id))).size > 0;
  } catch {
    return false; // never started, or the bytes are already gone
  }
}

/**
 * Put interrupted downloads back on the queue, keeping their ids.
 *
 * Keeping the id is the entire point. A consumer that polled `/gh/jobs/<id>` before the
 * restart polls the same URL after it and sees the transfer resume, rather than a dead
 * `failed` it has no way to retry against — and `transfer` picks up the surviving `.part`
 * with a `Range` request instead of pulling the bytes again.
 *
 * Both conditions are required. A record with no partial has nothing to resume from, so
 * re-queueing it would just be a silent retry of a download the caller never asked twice for;
 * it is left `failed` and the caller may re-POST if it still wants the file.
 *
 * Call this AFTER `load()` and BEFORE the retention sweep: re-queued records are unsettled
 * again, and the sweep never touches an unsettled record, so a partial that outlived the TTL
 * while the daemon was down is resumed rather than reclaimed out from under the transfer.
 *
 * Returns the ids it re-queued, so a caller — or a test — can see what happened.
 */
export async function requeueInterrupted(
  store: DownloadStore,
  submit: (id: string) => void,
): Promise<string[]> {
  const resumed: string[] = [];
  for (const rec of store.all()) {
    if (!wasInterruptedByRestart(rec)) continue;
    if (!(await hasPartial(store, rec.id))) continue;

    // Back to `queued` BEFORE the submit: an unsettled record is what makes `findOpen` fold a
    // caller's re-POST onto this same job instead of starting a second transfer for the same
    // target. The stale `error` and `completedAt` go with it, or `/gh/jobs/<id>` would report
    // a queued job that also carries a failure.
    await store.update(rec.id, { state: 'queued', error: undefined, completedAt: null });
    submit(rec.id);
    resumed.push(rec.id);
  }
  if (resumed.length > 0) {
    log.info('resumed downloads interrupted by a restart', { count: resumed.length, ids: resumed });
  }
  return resumed;
}
