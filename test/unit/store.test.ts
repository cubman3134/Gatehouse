import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadStore } from '../../src/downloads/store.js';
import type { DownloadRecord } from '../../src/downloads/record.js';
import { log } from '../../src/log.js';

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

  describe('findResumable', () => {
    // Set up one settled-failed record for `url` with the given failure and, unless told
    // otherwise, a surviving partial.
    const failedWith = async (
      s: DownloadStore,
      error: NonNullable<DownloadRecord['error']>,
      opts: { partial?: boolean; url?: string; state?: 'failed' | 'cancelled' } = {},
    ) => {
      const url = opts.url ?? 'http://x.test/a';
      const r = await s.create({ url, session: 'x.test', referer: null });
      if (opts.partial !== false) await writeFile(s.partPath(r.id), 'half a file');
      await s.update(r.id, { state: opts.state ?? 'failed', error, completedAt: clock });
      return r;
    };

    it('reclaims a transiently-failed record whose partial survived', async () => {
      const s = mk(); await s.load();
      const r = await failedWith(s, { code: 'network', message: 'connection reset' });
      expect((await s.findResumable('x.test', 'http://x.test/a'))?.id).toBe(r.id);
    });

    // Retrying these hits the same wall every time, so they are left alone and a fresh POST
    // gets a fresh id.
    it('refuses a permanent failure', async () => {
      for (const code of ['http-error', 'disk-full'] as const) {
        const s = mk(); await s.load();
        await failedWith(s, { code, message: 'no' });
        expect(await s.findResumable('x.test', 'http://x.test/a'), code).toBeUndefined();
      }
    });

    // The caller asked for it to stop and its partial is gone; folding a later request onto it
    // would resurrect something the caller retired.
    it('refuses a cancelled record', async () => {
      const s = mk(); await s.load();
      await failedWith(s, { code: 'cancelled', message: 'cancelled by the caller' }, { state: 'cancelled' });
      expect(await s.findResumable('x.test', 'http://x.test/a')).toBeUndefined();
    });

    // `load()`'s restart demotion carries code `cancelled`. That one belongs to
    // `requeueInterrupted`, at startup, not to a re-POST.
    it('refuses a record demoted by a restart', async () => {
      const s = mk(); await s.load();
      await failedWith(s, { code: 'cancelled', message: 'interrupted by a restart' });
      expect(await s.findResumable('x.test', 'http://x.test/a')).toBeUndefined();
    });

    it('refuses a record with no partial left to resume from', async () => {
      const s = mk(); await s.load();
      await failedWith(s, { code: 'network', message: 'reset' }, { partial: false });
      expect(await s.findResumable('x.test', 'http://x.test/a')).toBeUndefined();
    });

    it('does not cross sessions or urls', async () => {
      const s = mk(); await s.load();
      await failedWith(s, { code: 'network', message: 'reset' });
      expect(await s.findResumable('other', 'http://x.test/a')).toBeUndefined();
      expect(await s.findResumable('x.test', 'http://x.test/b')).toBeUndefined();
    });

    // Repeated failures leave several candidates. The newest has the furthest partial.
    it('prefers the most recent candidate', async () => {
      const s = mk(); await s.load();
      await failedWith(s, { code: 'network', message: 'reset' });
      clock = 9000;
      const newer = await failedWith(s, { code: 'network', message: 'reset' });
      expect((await s.findResumable('x.test', 'http://x.test/a'))?.id).toBe(newer.id);
    });
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

  it('writes a manifest that parses and leaves no tmp behind', async () => {
    const s = mk(); await s.load();
    await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    const files = await readdir(dir);
    expect(files).toContain('manifest.json');
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')); // must parse
  });

  it('writes the manifest atomically', async () => {
    const s = mk(); await s.load();
    await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });

    const p = join(dir, 'manifest.json');
    const before = await stat(p);
    await s.create({ url: 'http://x.test/b', session: 'x.test', referer: null });
    const after = await stat(p);

    // A rename swaps in a different file object; an in-place write would keep the same one.
    // This is what proves save() is tmp-then-rename rather than a truncating overwrite.
    expect(after.ino).not.toBe(before.ino);
  });

  it('demotes a running record to failed on restart', async () => {
    // Simulate a manifest with a running record that was interrupted
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify([
        {
          id: 'd1',
          url: 'http://x.test/a',
          session: 'x.test',
          referer: null,
          suggestedName: null,
          contentType: null,
          size: -1,
          received: 0,
          sha256: null,
          state: 'running',
          createdAt: 1000,
          completedAt: null,
          lastAccessAt: 1000,
        },
      ]),
      'utf8',
    );

    const s = mk(); await s.load();
    const r = s.get('d1');
    expect(r?.state).toBe('failed');
    expect(r?.error?.code).toBe('cancelled');
    expect(r?.completedAt).not.toBeNull();
    expect(s.findOpen('x.test', 'http://x.test/a')).toBeUndefined();
  });

  // A hand-edited or corrupt manifest can hold an id that is not one we could ever have
  // minted. `filePath`/`partPath` throw on those, and they are called from inside request
  // handlers and from the sweep — so the id has to be refused at the door, not later.
  it('drops a manifest record whose id could never be a path', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify([
          { id: '../../evil', url: 'http://x.test/a', session: 'x.test', referer: null, suggestedName: null, contentType: null, size: 1, received: 1, sha256: 'z', state: 'done', createdAt: 1, completedAt: 1, lastAccessAt: 1 },
          { id: 'd9', url: 'http://x.test/b', session: 'x.test', referer: null, suggestedName: null, contentType: null, size: 1, received: 1, sha256: 'z', state: 'done', createdAt: 1, completedAt: 1, lastAccessAt: 1 },
        ]),
        'utf8',
      );

      const s = mk(); await s.load();
      expect(s.get('../../evil')).toBeUndefined();
      expect(s.all().map((r) => r.id)).toEqual(['d9']);
      expect(warn).toHaveBeenCalled();

      // And the store still works: nothing downstream can be handed the bad id.
      await expect(s.sweep()).resolves.toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects invalid ids in filePath', async () => {
    const s = mk(); await s.load();
    expect(() => s.filePath('../../x')).toThrow();
    expect(() => s.filePath('..')).toThrow();
    expect(() => s.filePath('d1')).not.toThrow();
  });

  it('rejects invalid ids in partPath', async () => {
    const s = mk(); await s.load();
    expect(() => s.partPath('../../x')).toThrow();
    expect(() => s.partPath('..')).toThrow();
    expect(() => s.partPath('d1')).not.toThrow();
  });
});
