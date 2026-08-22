import { describe, it, expect } from 'vitest';
import { isSettled, isReclaimable, type DownloadRecord } from '../../src/downloads/record.js';

const rec = (over: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id: 'd1', url: 'http://example.test/f.bin', session: 'example.test', referer: null,
  suggestedName: 'f.bin', contentType: 'application/octet-stream',
  size: 100, received: 100, sha256: 'abc', state: 'done',
  createdAt: 1000, completedAt: 2000, lastAccessAt: 2000, ...over,
});

describe('isSettled', () => {
  it('is true for terminal states', () => {
    expect(isSettled('done')).toBe(true);
    expect(isSettled('failed')).toBe(true);
    expect(isSettled('cancelled')).toBe(true);
  });
  it('is false while work may still happen', () => {
    expect(isSettled('queued')).toBe(false);
    expect(isSettled('running')).toBe(false);
  });
});

describe('isReclaimable', () => {
  it('is true only for a completed download', () => {
    expect(isReclaimable(rec({ state: 'done' }))).toBe(true);
  });

  // The whole point: a sweep must never delete a file that is being written.
  it('is false for anything still in flight', () => {
    expect(isReclaimable(rec({ state: 'queued' }))).toBe(false);
    expect(isReclaimable(rec({ state: 'running' }))).toBe(false);
  });

  it('is true for a failed or cancelled record, which owns only a stale partial', () => {
    expect(isReclaimable(rec({ state: 'failed' }))).toBe(true);
    expect(isReclaimable(rec({ state: 'cancelled' }))).toBe(true);
  });
});
