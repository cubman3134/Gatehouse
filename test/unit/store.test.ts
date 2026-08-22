import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadStore } from '../../src/downloads/store.js';

let dir: string;
let clock = 1000;
let n = 0;
const mk = (over: Partial<{ ttlMs: number; maxBytes: number }> = {}) =>
  new DownloadStore({
    dir, now: () => clock, idgen: () => `d${++n}`,
    ttlMs: 60_000, maxBytes: 1_000_000, ...over,
  });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gh-store-')); clock = 1000; n = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('DownloadStore', () => {
  it('creates a record with an id and a queued state', async () => {
    const s = mk(); await s.load();
    const r = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    expect(r.id).toBe('d1');
    expect(r.state).toBe('queued');
    expect(r.createdAt).toBe(1000);
    expect(s.get('d1')).toEqual(r);
  });

  it('dedupes an open record for the same session+url', async () => {
    const s = mk(); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    expect(s.findOpen('x.test', 'http://x.test/a')?.id).toBe(a.id);
    expect(s.findOpen('x.test', 'http://x.test/b')).toBeUndefined();
    expect(s.findOpen('other', 'http://x.test/a')).toBeUndefined();
  });

  it('stops deduping once the record settles', async () => {
    const s = mk(); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    await s.update(a.id, { state: 'failed' });
    expect(s.findOpen('x.test', 'http://x.test/a')).toBeUndefined();
  });

  it('survives a reload from the manifest', async () => {
    const s = mk(); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    await s.update(a.id, { state: 'done', size: 5, received: 5, sha256: 'zz', completedAt: 1500 });

    const s2 = mk(); await s2.load();
    const back = s2.get(a.id);
    expect(back?.state).toBe('done');
    expect(back?.sha256).toBe('zz');
  });

  it('tolerates a corrupt manifest rather than refusing to start', async () => {
    await writeFile(join(dir, 'manifest.json'), '{not json', 'utf8');
    const s = mk();
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.all()).toEqual([]);
  });

  it('remove deletes the record and both possible files', async () => {
    const s = mk(); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    await writeFile(s.partPath(a.id), 'partial');
    await writeFile(s.filePath(a.id), 'whole');

    expect(await s.remove(a.id)).toBe(true);
    expect(s.get(a.id)).toBeUndefined();
    const left = (await readdir(dir)).filter((f) => f.startsWith(a.id));
    expect(left).toEqual([]);
    expect(await s.remove(a.id)).toBe(false);
  });

  // The sweep is the safety net for a consumer that never calls DELETE.
  it('sweeps a completed record past its TTL', async () => {
    const s = mk({ ttlMs: 500 }); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    await writeFile(s.filePath(a.id), 'x');
    await s.update(a.id, { state: 'done', completedAt: 1000, lastAccessAt: 1000, size: 1, received: 1 });

    clock = 1400;
    expect(await s.sweep()).toEqual([]);
    clock = 1600;
    expect(await s.sweep()).toEqual([a.id]);
    expect(s.get(a.id)).toBeUndefined();
  });

  // The property that matters most: never delete bytes something is writing.
  it('never sweeps a record that is still in flight, however old or large', async () => {
    const s = mk({ ttlMs: 1, maxBytes: 1 }); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    await s.update(a.id, { state: 'running', received: 999_999 });
    await writeFile(s.partPath(a.id), 'x'.repeat(500));

    clock = 999_999;
    expect(await s.sweep()).toEqual([]);
    expect(s.get(a.id)?.state).toBe('running');
  });

  it('evicts least-recently-accessed completed files when over the size cap', async () => {
    const s = mk({ ttlMs: 10_000_000, maxBytes: 10 }); await s.load();
    for (const [id, access] of [['d1', 300], ['d2', 100], ['d3', 200]] as const) {
      const r = await s.create({ url: 'http://x.test/' + id, session: 'x.test', referer: null });
      await writeFile(s.filePath(r.id), 'xxxx'); // 4 bytes each, 12 total > cap of 10
      await s.update(r.id, { state: 'done', size: 4, received: 4, completedAt: 50, lastAccessAt: access });
    }
    const swept = await s.sweep();
    expect(swept).toEqual(['d2']); // oldest access first, and one eviction suffices (8 <= 10)
    expect(s.get('d1')).toBeDefined();
    expect(s.get('d3')).toBeDefined();
  });

  it('touch bumps lastAccessAt so serving a file protects it', async () => {
    const s = mk(); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    await s.update(a.id, { state: 'done', lastAccessAt: 1000 });
    clock = 7777;
    await s.touch(a.id);
    expect(s.get(a.id)?.lastAccessAt).toBe(7777);
  });

  it('writes the manifest atomically, leaving no tmp file behind', async () => {
    const s = mk(); await s.load();
    await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    const files = await readdir(dir);
    expect(files).toContain('manifest.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')); // must parse
  });
});
