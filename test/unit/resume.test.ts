import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadStore, INTERRUPTED_BY_RESTART } from '../../src/downloads/store.js';
import { requeueInterrupted, wasInterruptedByRestart } from '../../src/downloads/resume.js';
import type { DownloadRecord, DownloadState } from '../../src/downloads/record.js';
import type { JobError } from '../../src/jobs/queue.js';

/**
 * The re-queue is `main.ts`'s decision, made where the queue exists — but the DECISION is
 * pure, so it lives in its own module and is tested here without an Electron. Importing
 * `main.ts` is not an option: it imports `electron` at the top level and registers an
 * `app.on` handler on load, so a unit test of it would need a real browser process.
 *
 * What this covers is the gap the review found: `transfer` can resume from a `<id>.part`, and
 * that is well tested, but before this nothing ever called it a second time for the same id.
 */

let dir: string;
let clock = 1000;
const mk = (): DownloadStore =>
  new DownloadStore({ dir, now: () => clock, idgen: () => 'never', ttlMs: 60_000, maxBytes: 1_000_000 });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gh-resume-')); clock = 1000; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A manifest record as it looked when the previous process was killed mid-transfer. */
function manifestRecord(id: string, over: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id,
    url: `http://x.test/${id}`,
    session: 'x.test',
    referer: null,
    suggestedName: null,
    contentType: null,
    size: 100,
    received: 40,
    sha256: null,
    state: 'running' as DownloadState,
    createdAt: 900,
    completedAt: null,
    lastAccessAt: 900,
    ...over,
  };
}

async function seed(records: DownloadRecord[], partials: Record<string, string> = {}): Promise<DownloadStore> {
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(records), 'utf8');
  for (const [id, body] of Object.entries(partials)) await writeFile(join(dir, `${id}.part`), body, 'utf8');
  const s = mk();
  await s.load();
  return s;
}

describe('wasInterruptedByRestart', () => {
  // The predicate is the load-bearing half: re-queueing a download that failed for a REAL
  // reason would make the daemon retry a 404 on every single start.
  const rec = (state: DownloadState, error?: JobError): DownloadRecord =>
    manifestRecord('d1', error ? { state, error } : { state });

  it('matches exactly what load() stamps on an interrupted record', () => {
    expect(wasInterruptedByRestart(rec('failed', { code: 'cancelled', message: INTERRUPTED_BY_RESTART }))).toBe(true);
  });

  it('refuses a download that failed for a real reason', () => {
    expect(wasInterruptedByRestart(rec('failed', { code: 'http-error', message: 'server answered 404' }))).toBe(false);
    expect(wasInterruptedByRestart(rec('failed', { code: 'network', message: 'socket hang up' }))).toBe(false);
    expect(wasInterruptedByRestart(rec('failed', { code: 'disk-full', message: 'ENOSPC' }))).toBe(false);
    // A caller's DELETE lands as `cancelled` with the transfer's own message, not this one.
    expect(wasInterruptedByRestart(rec('cancelled', { code: 'cancelled', message: 'cancelled by the caller' }))).toBe(false);
    expect(wasInterruptedByRestart(rec('failed'))).toBe(false);
  });

  it('refuses a record that never failed at all', () => {
    expect(wasInterruptedByRestart(rec('done'))).toBe(false);
    expect(wasInterruptedByRestart(rec('queued'))).toBe(false);
  });
});

describe('requeueInterrupted', () => {
  it('re-queues an interrupted download that still has its partial, under the same id', async () => {
    const s = await seed([manifestRecord('d1')], { d1: 'forty bytes of it, near enough' });
    // Precondition — this is what load() leaves behind, and why the resume had no caller.
    expect(s.get('d1')?.state).toBe('failed');
    expect(s.findOpen('x.test', 'http://x.test/d1')).toBeUndefined();

    const submitted: string[] = [];
    const resumed = await requeueInterrupted(s, (id) => submitted.push(id));

    expect(resumed).toEqual(['d1']);
    expect(submitted).toEqual(['d1']); // it was actually handed to the queue, not just re-stated
    const back = s.get('d1');
    expect(back?.state).toBe('queued');
    expect(back?.error).toBeUndefined(); // no queued job that also reports a failure
    expect(back?.completedAt).toBeNull();
    // The whole point: the caller's handle still works, and a re-POST folds onto it rather
    // than minting a second id and a second partial for the same target.
    expect(s.findOpen('x.test', 'http://x.test/d1')?.id).toBe('d1');
  });

  it('leaves an interrupted download with no partial alone', async () => {
    const s = await seed([manifestRecord('d1')]); // no d1.part on disk
    const submitted: string[] = [];
    expect(await requeueInterrupted(s, (id) => submitted.push(id))).toEqual([]);
    expect(submitted).toEqual([]);
    expect(s.get('d1')?.state).toBe('failed');
  });

  it('treats a zero-byte partial as nothing to resume from', async () => {
    const s = await seed([manifestRecord('d1')], { d1: '' });
    expect(await requeueInterrupted(s, () => {})).toEqual([]);
    expect(s.get('d1')?.state).toBe('failed');
  });

  it('never re-queues a download that failed for a real reason, partial or not', async () => {
    const s = await seed(
      [manifestRecord('d1', { state: 'failed', error: { code: 'http-error', message: 'server answered 404' }, completedAt: 950 })],
      { d1: 'some bytes' },
    );
    const submitted: string[] = [];
    expect(await requeueInterrupted(s, (id) => submitted.push(id))).toEqual([]);
    expect(submitted).toEqual([]);
    expect(s.get('d1')?.state).toBe('failed');
  });

  it('leaves completed and cancelled records untouched', async () => {
    const s = await seed(
      [
        manifestRecord('d1', { state: 'done', received: 100, sha256: 'zz', completedAt: 950 }),
        manifestRecord('d2', { state: 'cancelled', error: { code: 'cancelled', message: 'cancelled by the caller' }, completedAt: 950 }),
      ],
      { d1: 'stale', d2: 'stale' },
    );
    expect(await requeueInterrupted(s, () => {})).toEqual([]);
    expect(s.get('d1')?.state).toBe('done');
    expect(s.get('d2')?.state).toBe('cancelled');
  });

  it('re-queues several at once and reports how many', async () => {
    const s = await seed(
      [manifestRecord('d1'), manifestRecord('d2'), manifestRecord('d3')],
      { d1: 'bytes', d3: 'bytes' }, // d2 has no partial
    );
    const submitted: string[] = [];
    expect((await requeueInterrupted(s, (id) => submitted.push(id))).sort()).toEqual(['d1', 'd3']);
    expect(submitted.sort()).toEqual(['d1', 'd3']);
    expect(s.get('d2')?.state).toBe('failed');
  });

  // The ordering `main.ts` relies on: re-queue first, sweep second. A re-queued record is
  // unsettled, and the sweep never touches an unsettled record — so a partial that outlived
  // the TTL while the daemon was down is resumed rather than deleted under the transfer.
  it('puts the record beyond the reach of the sweep that follows it', async () => {
    const s = await seed([manifestRecord('d1')], { d1: 'bytes that took an hour to fetch' });
    clock = 10_000_000; // far past the 60s TTL
    await requeueInterrupted(s, () => {});
    expect(await s.sweep()).toEqual([]);
    expect(s.get('d1')?.state).toBe('queued');
  });

  it('is a no-op on a store with nothing interrupted', async () => {
    const s = mk();
    await s.load();
    expect(await requeueInterrupted(s, () => { throw new Error('must not submit'); })).toEqual([]);
  });
});
