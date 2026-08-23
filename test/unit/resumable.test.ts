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
