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

  it('floors a fractional startTime, which Chromium rejects', () => {
    const p = planResume(rec({ resume: { ...full, startTimeSec: 1_700_000_000.75 } }), 40);
    expect(p.kind).toBe('resume');
    if (p.kind === 'resume') expect(p.args.startTime).toBe(1_700_000_000);
  });

  it('carries the rest of the args Chromium needs', () => {
    const p = planResume(rec({ resume: full }), 40);
    expect(p.kind).toBe('resume');
    if (p.kind === 'resume') {
      expect(p.args.mimeType).toBe('application/octet-stream');
      expect(p.args.length).toBe(100);
      expect(p.args.lastModified).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
    }
  });

  it('restarts when the partial already reaches the claimed size', () => {
    const p = planResume(rec({ resume: full }), 100);
    expect(p.kind).toBe('restart');
    if (p.kind === 'restart') expect(p.reason).toMatch(/already at or larger/i);
  });

  it('restarts when no url chain was recorded', () => {
    const p = planResume(rec({ resume: { ...full, urlChain: [] } }), 40);
    expect(p.kind).toBe('restart');
  });

  it('does not misfire the size guard when there is no Content-Length', () => {
    // totalBytes 0 means "the server did not say" — normal for brotli, not an error.
    const p = planResume(rec({ resume: { ...full, totalBytes: 0 } }), 40);
    expect(p.kind).toBe('resume');
  });

  it('restarts when the partial size is negative', () => {
    expect(planResume(rec({ resume: full }), -1).kind).toBe('restart');
  });

  it('restarts when the partial is larger than the file claimed to be', () => {
    const p = planResume(rec({ resume: full }), 500);
    expect(p.kind).toBe('restart');
    if (p.kind === 'restart') expect(p.reason).toMatch(/larger/i);
  });

  it('uses the ACTUAL partial size as the offset, not the recorded counter', () => {
    // Unconditional first: without this the whole body sits inside a type narrow and the test
    // passes against an implementation that returns `restart` for this input.
    expect(planResume(rec({ resume: { ...full, receivedBytes: 12 } }), 40).kind).toBe('resume');
    // The recorded counter is throttled and can lag; the file on disk is the truth.
    const p = planResume(rec({ resume: { ...full, receivedBytes: 12 } }), 40);
    if (p.kind === 'resume') expect(p.args.offset).toBe(40);
  });
});
