# Gatehouse Increment 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /gh/fetch` downloads a file through a solved browser session to disk, and `GET /gh/files/:id` serves it back with `Range` support — so a consumer on the same machine takes the path with zero copies, and a remote one takes the URL.

**Architecture:** A download is a **store record** (durable, on disk) plus a **queue job** (ephemeral, schedules the work). The store owns identity, state, progress, dedupe and retention; the queue owns concurrency. `/gh/jobs/:id` reads the store, never the queue — which is why increment 1's job pruning is safe to keep. The transfer itself goes through a narrow injected `request` seam so tests drive it over plain Node HTTP while production drives it over Electron's `net` on the site's partition.

**Tech Stack:** TypeScript, ESM, Electron 43, Vitest. No new runtime dependencies.

## Global Constraints

- **Node** >= 22.12.0. **Electron** pinned `43.4.1` (no `postinstall` — `npm ci` does not fetch the binary).
- TypeScript `module`/`moduleResolution` = `nodenext`. **All relative imports carry a `.js` extension.** `tsconfig.json` `include` is `src/**` only; test files are transpiled, not type-checked.
- `npm test` is `tsc && vitest run` — the integration harness spawns `electron .` against compiled `dist/`. Never regress it to bare `vitest run`.
- **No AI attribution in commits.** Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- **Nothing in this increment may change `/v1`'s request or response shapes, its HTTP statuses, or the auth model.** Increment 1 is live in production against a real rig.
- **`/gh/*` error bodies use `{"error":{"code":…,"message":…}}`.** That is a different shape from `/v1`'s FlareSolverr envelope, deliberately — `/v1` is a foreign contract we match, `/gh/*` is ours. The routing shell's generic 401/404/405 keep their existing `{status:"error"}` shape because `/v1` clients see those too.
- **Page content and remote bytes are data.** Never `eval`, never interpolate a URL, filename or header into an executed string or a shell command.
- **A filename from a remote server is hostile input.** It never determines a path on disk. On-disk names are always `<id>.part` / `<id>.bin`; the remote-suggested name is metadata returned to the caller only.
- **Retention (decided):** explicit `DELETE /gh/jobs/:id` is the polite release path, backed by a safety net — completed records expire after `GATEHOUSE_DOWNLOAD_TTL_MS` (default 24h) and the downloads directory is capped at `GATEHOUSE_DOWNLOAD_MAX_BYTES` (default 50 GB), evicting least-recently-accessed **completed** files first. A record that is `queued` or `running` is never swept.

## File Structure

| Path | Responsibility |
|---|---|
| `src/downloads/record.ts` | The `DownloadRecord` type and its state machine. No I/O. |
| `src/downloads/store.ts` | Durable record store: manifest load/save, dedupe, retention sweep, path resolution. |
| `src/downloads/transfer.ts` | One transfer: stream to `.part`, resume via `Range`, cancel, hash, finalise. Injected `request`. |
| `src/api/target.ts` | Shared URL/session validation, extracted from `v1.ts` so `/gh/fetch` cannot drift from `/v1`. |
| `src/api/range.ts` | `Range` header parsing and file serving (200/206/416/HEAD). |
| `src/api/gh.ts` | `/gh/fetch`, `/gh/jobs/:id`, `/gh/files/:id` handlers. |
| `src/api/server.ts` | *(modify)* route the new paths |
| `src/main.ts` | *(modify)* wire store + download queue + the Electron `net` request seam |
| `src/config.ts` | *(modify)* four new settings |
| `test/fixture/filehost.ts` | A file host with real `Range` support, plus modes that refuse it, stall, and truncate. |

---

### Task 1: Config settings and the download record

**Files:**
- Create: `src/downloads/record.ts`
- Modify: `src/config.ts`
- Test: `test/unit/record.test.ts`, `test/unit/config.test.ts` (extend)

**Interfaces:**
- Consumes: `FailureCode` from `src/jobs/queue.ts`
- Produces:
  - `type DownloadState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'`
  - `interface DownloadRecord { id, url, session, referer, suggestedName, contentType, size, received, sha256, state, error?, createdAt, completedAt, lastAccessAt }`
  - `function isSettled(s: DownloadState): boolean`
  - `function isReclaimable(r: DownloadRecord): boolean`
  - `GatehouseConfig` gains `downloadsDir: string`, `downloadConcurrency: number`, `downloadTtlMs: number`, `downloadMaxBytes: number`

- [ ] **Step 1: Write the failing test for the record**

Create `test/unit/record.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/record.test.ts`
Expected: FAIL — cannot resolve `../../src/downloads/record.js`

- [ ] **Step 3: Implement `src/downloads/record.ts`**

```ts
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
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/unit/record.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the failing config test**

Append to `test/unit/config.test.ts`, inside the existing `describe('loadConfig', …)`:

```ts
  it('defaults the download settings', () => {
    const c = loadConfig({});
    expect(c.downloadConcurrency).toBe(2);
    expect(c.downloadTtlMs).toBe(86_400_000);
    expect(c.downloadMaxBytes).toBe(50 * 1024 * 1024 * 1024);
    expect(c.downloadsDir).toBe('');
  });

  it('accepts explicit download settings', () => {
    const c = loadConfig({
      GATEHOUSE_DOWNLOADS_DIR: 'D:/gh',
      GATEHOUSE_DOWNLOAD_CONCURRENCY: '5',
      GATEHOUSE_DOWNLOAD_TTL_MS: '3600000',
      GATEHOUSE_DOWNLOAD_MAX_BYTES: '1073741824',
    });
    expect(c.downloadsDir).toBe('D:/gh');
    expect(c.downloadConcurrency).toBe(5);
    expect(c.downloadTtlMs).toBe(3_600_000);
    expect(c.downloadMaxBytes).toBe(1_073_741_824);
  });

  it('rejects out-of-range download settings', () => {
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_CONCURRENCY: '17' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_TTL_MS: '999' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_DOWNLOAD_MAX_BYTES: '0' })).toThrow(ConfigError);
  });
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — `expected undefined to be 2`

- [ ] **Step 7: Extend `src/config.ts`**

Add the four fields to the `GatehouseConfig` interface:

```ts
  /** Absolute path for downloaded files. Empty means "derive from Electron's userData". */
  downloadsDir: string;
  downloadConcurrency: number;
  /** How long a completed download's bytes survive without being released. */
  downloadTtlMs: number;
  /** Cap on the downloads directory; least-recently-accessed completed files evict first. */
  downloadMaxBytes: number;
```

And add to the object `loadConfig` returns:

```ts
    downloadsDir: env.GATEHOUSE_DOWNLOADS_DIR?.trim() || '',
    downloadConcurrency: intFrom(env.GATEHOUSE_DOWNLOAD_CONCURRENCY, 2, 'GATEHOUSE_DOWNLOAD_CONCURRENCY', 1, 16),
    downloadTtlMs: intFrom(env.GATEHOUSE_DOWNLOAD_TTL_MS, 86_400_000, 'GATEHOUSE_DOWNLOAD_TTL_MS', 60_000, 2_592_000_000),
    downloadMaxBytes: intFrom(
      env.GATEHOUSE_DOWNLOAD_MAX_BYTES, 50 * 1024 * 1024 * 1024, 'GATEHOUSE_DOWNLOAD_MAX_BYTES',
      1024 * 1024, Number.MAX_SAFE_INTEGER,
    ),
```

`downloadsDir` is deliberately not resolved here: `config.ts` must stay free of Electron so the unit tests need no browser. `main.ts` resolves the empty default against `app.getPath('userData')`.

- [ ] **Step 8: Run both test files and confirm they pass**

Run: `npx vitest run test/unit/config.test.ts test/unit/record.test.ts`
Expected: PASS — config file gains 3 tests, record file has 6

- [ ] **Step 9: Commit**

```bash
git add src/downloads/record.ts src/config.ts test/unit/record.test.ts test/unit/config.test.ts
git commit -m "feat: download record and its retention settings

A record is reclaimable only once it has settled, so a retention sweep can
never delete bytes something is still writing. The remote-suggested filename is
carried as metadata and never as a path — on disk a download is always its id."
```

---

### Task 2: The download store

**Files:**
- Create: `src/downloads/store.ts`
- Test: `test/unit/store.test.ts`

**Interfaces:**
- Consumes: `DownloadRecord`, `DownloadState`, `isReclaimable` (Task 1)
- Produces:
  - `interface StoreOptions { dir: string; now: () => number; idgen: () => string; ttlMs: number; maxBytes: number }`
  - `class DownloadStore` with `load(): Promise<void>`, `get(id): DownloadRecord | undefined`, `all(): DownloadRecord[]`, `findOpen(session, url): DownloadRecord | undefined`, `create(init): Promise<DownloadRecord>`, `update(id, patch): Promise<DownloadRecord | undefined>`, `remove(id): Promise<boolean>`, `sweep(): Promise<string[]>`, `touch(id): Promise<void>`, `partPath(id): string`, `filePath(id): string`, `nowMs(): number`, `readonly dir: string`

- [ ] **Step 1: Write the failing test**

Create `test/unit/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
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

  // NOTE (corrected during review): the test below does NOT test atomicity — it survives a
  // mutant that writes in place with no tmp and no rename. Keep it under this honest name,
  // and pin atomicity separately with `stat().ino`: a rename swaps in a different file
  // object, an in-place write keeps the same one. No mocking required.
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
    expect(after.ino).not.toBe(before.ino);
  });

  it('demotes a running record to failed on restart', async () => {
    const s = mk(); await s.load();
    const a = await s.create({ url: 'http://x.test/a', session: 'x.test', referer: null });
    await s.update(a.id, { state: 'running', received: 40 });

    // The process that owned that transfer is gone. A stale `running` record would wedge its
    // session+url pair forever, because findOpen would keep deduping onto a job nothing runs.
    const s2 = mk(); await s2.load();
    const back = s2.get(a.id)!;
    expect(back.state).toBe('failed');
    expect(back.error?.code).toBe('cancelled');
    expect(back.completedAt).not.toBeNull(); // or its TTL would run from when it STARTED
    expect(s2.findOpen('x.test', 'http://x.test/a')).toBeUndefined();
  });

  it('refuses a path-unsafe id', () => {
    const s = mk();
    expect(() => s.filePath('../../x')).toThrow();
    expect(() => s.partPath('..')).toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/store.test.ts`
Expected: FAIL — cannot resolve `../../src/downloads/store.js`

- [ ] **Step 3: Implement `src/downloads/store.ts`**

```ts
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isReclaimable, isSettled, type DownloadRecord } from './record.js';
import { log } from '../log.js';

export interface StoreOptions {
  dir: string;
  now: () => number;
  idgen: () => string;
  ttlMs: number;
  maxBytes: number;
}

export interface DownloadInit {
  url: string;
  session: string;
  referer: string | null;
}

const MANIFEST = 'manifest.json';

/**
 * Durable home for download records. The queue that schedules a transfer is ephemeral and its
 * jobs are pruned on settle; THIS is what `/gh/jobs/:id` reads, which is why a caller can poll
 * — and fetch the bytes — long after the transfer finished.
 */
export class DownloadStore {
  private readonly records = new Map<string, DownloadRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: StoreOptions) {}

  get dir(): string { return this.opts.dir; }

  /** The store's clock. `transfer` stamps completion times with it so a test's injected
   *  clock governs those too, rather than transfer reaching for `Date.now()` of its own. */
  nowMs(): number { return this.opts.now(); }

  /** `<id>.part` while transferring, `<id>.bin` once complete. Never a remote-supplied name. */
  partPath(id: string): string { return join(this.opts.dir, `${id}.part`); }
  filePath(id: string): string { return join(this.opts.dir, `${id}.bin`); }

  async load(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(join(this.opts.dir, MANIFEST), 'utf8');
    } catch {
      return; // first run
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error('manifest is not an array');
      for (const r of parsed as DownloadRecord[]) {
        if (r && typeof r.id === 'string') {
          // Nothing can be mid-transfer across a restart: the process that owned it is gone.
          // Demote so a stale `running` cannot block dedupe or survive a sweep forever.
          this.records.set(r.id, isSettled(r.state) ? r : { ...r, state: 'failed', error: { code: 'cancelled', message: 'interrupted by a restart' } });
        }
      }
    } catch (e: unknown) {
      // A corrupt manifest must not stop the daemon starting. The files are still on disk and
      // the sweep will not know about them, which is a leak we accept over a refusal to boot.
      log.warn('downloads manifest unreadable, starting empty', { message: e instanceof Error ? e.message : String(e) });
      this.records.clear();
    }
  }

  get(id: string): DownloadRecord | undefined { return this.records.get(id); }
  all(): DownloadRecord[] { return [...this.records.values()]; }

  /** An unsettled record for this exact target, or undefined. The dedupe key. */
  findOpen(session: string, url: string): DownloadRecord | undefined {
    for (const r of this.records.values()) {
      if (!isSettled(r.state) && r.session === session && r.url === url) return r;
    }
    return undefined;
  }

  async create(init: DownloadInit): Promise<DownloadRecord> {
    const t = this.opts.now();
    const rec: DownloadRecord = {
      id: this.opts.idgen(),
      url: init.url,
      session: init.session,
      referer: init.referer,
      suggestedName: null,
      contentType: null,
      size: -1,
      received: 0,
      sha256: null,
      state: 'queued',
      createdAt: t,
      completedAt: null,
      lastAccessAt: t,
    };
    this.records.set(rec.id, rec);
    await this.save();
    return rec;
  }

  async update(id: string, patch: Partial<DownloadRecord>): Promise<DownloadRecord | undefined> {
    const cur = this.records.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.records.set(id, next);
    await this.save();
    return next;
  }

  async touch(id: string): Promise<void> {
    const cur = this.records.get(id);
    if (!cur) return;
    this.records.set(id, { ...cur, lastAccessAt: this.opts.now() });
    await this.save();
  }

  /** Drop the record and both possible files. Returns false if the id was unknown. */
  async remove(id: string): Promise<boolean> {
    if (!this.records.delete(id)) return false;
    await rm(this.partPath(id), { force: true });
    await rm(this.filePath(id), { force: true });
    await this.save();
    return true;
  }

  /**
   * The retention safety net, for a consumer that never calls DELETE. Removes completed
   * records past the TTL, then evicts least-recently-accessed completed records until the
   * directory is under the cap. An unsettled record is never touched, at any age or size.
   */
  async sweep(): Promise<string[]> {
    const now = this.opts.now();
    const removed: string[] = [];

    for (const r of [...this.records.values()]) {
      if (!isReclaimable(r)) continue;
      const since = r.completedAt ?? r.createdAt;
      if (now - since > this.opts.ttlMs) {
        await this.remove(r.id);
        removed.push(r.id);
      }
    }

    const sized = await Promise.all(
      [...this.records.values()].map(async (r) => ({ r, bytes: await this.bytesOf(r.id) })),
    );
    let total = sized.reduce((n, x) => n + x.bytes, 0);
    if (total <= this.opts.maxBytes) return removed;

    const victims = sized
      .filter((x) => isReclaimable(x.r))
      .sort((a, b) => a.r.lastAccessAt - b.r.lastAccessAt);

    for (const v of victims) {
      if (total <= this.opts.maxBytes) break;
      await this.remove(v.r.id);
      removed.push(v.r.id);
      total -= v.bytes;
    }
    return removed;
  }

  private async bytesOf(id: string): Promise<number> {
    let n = 0;
    for (const p of [this.filePath(id), this.partPath(id)]) {
      try { n += (await stat(p)).size; } catch { /* absent */ }
    }
    return n;
  }

  /**
   * Atomic: write a sibling tmp then rename over the manifest, so a crash mid-write leaves the
   * previous manifest intact rather than a truncated one. Serialised through `writing` because
   * concurrent transfers update progress from several places at once.
   */
  private save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const tmp = join(this.opts.dir, `${MANIFEST}.tmp`);
      await writeFile(tmp, JSON.stringify([...this.records.values()]), 'utf8');
      await rename(tmp, join(this.opts.dir, MANIFEST));
    }).catch((e: unknown) => {
      log.warn('could not persist the downloads manifest', { message: e instanceof Error ? e.message : String(e) });
    });
    return this.writing;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/unit/store.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Mutation-check the two load-bearing guards**

Run each, confirm RED, then restore:

1. In `sweep`, drop the `if (!isReclaimable(r)) continue;` guard — `never sweeps a record that is still in flight` must fail.
2. In `findOpen`, drop the `!isSettled(r.state)` clause — `stops deduping once the record settles` must fail.

Record the failing test name and output for each.

- [ ] **Step 6: Commit**

```bash
git add src/downloads/store.ts test/unit/store.test.ts
git commit -m "feat: durable download store with a retention sweep

The store is what /gh/jobs reads, not the ephemeral queue, so a caller can poll
and fetch bytes long after the transfer settled. A sweep never touches a record
that is still in flight, at any age or size. A restart demotes any record left
running — the process that owned it is gone — so a stale entry cannot block
dedupe forever, and a corrupt manifest starts empty rather than refusing to boot."
```

---

### Task 3: Range parsing and file serving

**Files:**
- Create: `src/api/range.ts`
- Test: `test/unit/range.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface ByteRange { start: number; end: number }`
  - `function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null`
  - `function serveFile(req: IncomingMessage, res: ServerResponse, opts: { path: string; size: number; contentType: string | null; filename: string | null }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/range.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, serveFile } from '../../src/api/range.js';

describe('parseRange', () => {
  it('returns null when there is no Range header', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('', 100)).toBeNull();
  });
  it('parses a closed range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  });
  it('parses an open-ended range', () => {
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
  });
  it('parses a suffix range', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });
  it('clamps an end past EOF', () => {
    expect(parseRange('bytes=95-500', 100)).toEqual({ start: 95, end: 99 });
  });
  it('calls a start past EOF unsatisfiable', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=200-300', 100)).toBe('unsatisfiable');
  });
  it('calls a reversed or zero-suffix range unsatisfiable', () => {
    expect(parseRange('bytes=50-10', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
  it('ignores a unit it does not understand, rather than erroring', () => {
    expect(parseRange('items=0-9', 100)).toBeNull();
  });
  // A server MAY ignore Range. Serving the whole body is always correct; assembling a
  // multipart/byteranges response is not worth the surface for this consumer.
  it('ignores a multi-range request', () => {
    expect(parseRange('bytes=0-9,20-29', 100)).toBeNull();
  });
  it('ignores a garbage range', () => {
    expect(parseRange('bytes=abc', 100)).toBeNull();
    expect(parseRange('bytes=', 100)).toBeNull();
  });
  it('calls any range unsatisfiable for an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

describe('serveFile', () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (dir) await rm(dir, { recursive: true, force: true });
    server = undefined; dir = undefined;
  });

  async function host(body: string, contentType: string | null = 'application/octet-stream', filename: string | null = 'thing.bin') {
    dir = await mkdtemp(join(tmpdir(), 'gh-range-'));
    const path = join(dir, 'f.bin');
    await writeFile(path, body);
    server = createServer((req, res) => {
      void serveFile(req, res, { path, size: Buffer.byteLength(body), contentType, filename });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`;
  }

  it('serves the whole file with an accept-ranges header', async () => {
    const url = await host('0123456789');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('10');
    expect(await res.text()).toBe('0123456789');
  });

  it('serves a 206 for a byte range', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { headers: { range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('serves a 206 for an open-ended range', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { headers: { range: 'bytes=7-' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('789');
  });

  it('answers 416 with a content-range for an unsatisfiable range', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { headers: { range: 'bytes=50-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('answers HEAD with headers and no body', async () => {
    const url = await host('0123456789');
    const res = await fetch(url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('');
  });

  it('sets a content-disposition carrying the suggested filename', async () => {
    const url = await host('0123456789', 'application/zip', 'my file.zip');
    const res = await fetch(url);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain("filename*=UTF-8''my%20file.zip");
  });

  // A remote server chose this name. It must not be able to inject a header.
  it('cannot be header-injected through the filename', async () => {
    const url = await host('0123456789', 'application/zip', 'evil\r\nX-Injected: yes\r\n.zip');
    const res = await fetch(url);
    expect(res.headers.get('x-injected')).toBeNull();
    expect(res.headers.get('content-disposition') ?? '').not.toContain('\n');
  });

  it('falls back to a generic content type when none is known', async () => {
    const url = await host('0123456789', null, null);
    const res = await fetch(url);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/range.test.ts`
Expected: FAIL — cannot resolve `../../src/api/range.js`

- [ ] **Step 3: Implement `src/api/range.ts`**

```ts
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ByteRange { start: number; end: number }

/**
 * Parse a `Range` header against a known size.
 *
 * Returns `null` for "serve the whole thing" — no header, an unknown unit, a multi-range
 * request, or garbage. A server is always permitted to ignore `Range`, and assembling a
 * `multipart/byteranges` body is surface this consumer does not need.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(.+)$/i.exec(header.trim());
  if (!m) return null;

  const spec = m[1]!.trim();
  if (spec.includes(',')) return null; // multi-range: ignore
  const dash = spec.indexOf('-');
  if (dash === -1) return null;

  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    if (!/^\d+$/.test(rawEnd)) return null;
    const n = Number(rawEnd);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }

  if (!/^\d+$/.test(rawStart)) return null;
  const start = Number(rawStart);
  if (start >= size) return 'unsatisfiable';

  if (rawEnd === '') return { start, end: size - 1 };
  if (!/^\d+$/.test(rawEnd)) return null;
  const end = Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * RFC 6266 / RFC 5987. The name came from a remote server, so it is percent-encoded into the
 * `filename*` form — a raw CR or LF in a header value would be request smuggling.
 */
function contentDisposition(filename: string | null): string {
  if (!filename) return 'attachment';
  const safe = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename*=UTF-8''${safe}`;
}

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { path: string; size: number; contentType: string | null; filename: string | null },
): Promise<void> {
  const range = parseRange(req.headers.range, opts.size);

  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${opts.size}`, 'accept-ranges': 'bytes' });
    res.end();
    return;
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, opts.size - 1);
  const length = opts.size === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/octet-stream',
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(opts.filename),
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${opts.size}`;

  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || length === 0) { res.end(); return; }

  await pipeline(createReadStream(opts.path, { start, end }), res);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/unit/range.test.ts`
Expected: PASS, 19 tests

- [ ] **Step 5: Commit**

```bash
git add src/api/range.ts test/unit/range.test.ts
git commit -m "feat: Range parsing and file serving

Ignoring an unparseable or multi-range header and serving the whole body is
always a correct answer, and avoids assembling multipart/byteranges for a
consumer that never asks for it. The filename came from a remote server, so it
goes out percent-encoded in the RFC 5987 form — a raw CRLF there would be
header injection."
```

---

### Task 4: The transfer engine

**Files:**
- Create: `src/downloads/transfer.ts`, `test/fixture/filehost.ts`
- Test: `test/unit/transfer.test.ts`

**Interfaces:**
- Consumes: `DownloadStore` (Task 2), `DownloadRecord` (Task 1), `FailureCode` (increment 1)
- Produces:
  - `interface TransferResponse { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array>; abort(): void }`
  - `type Requester = (req: { url: string; headers: Record<string, string>; session: string }) => Promise<TransferResponse>`
  - `function transfer(id: string, store: DownloadStore, request: Requester, signal: AbortSignal): Promise<void>`
  - Fixture: `startFileHost(opts?: { mode?: 'range' | 'no-range' | 'truncate' | 'stall'; body?: Buffer; filename?: string })` → `{ url, close(), requests: Array<{range: string | undefined}> }`

- [ ] **Step 1: Implement the file-host fixture**

Create `test/fixture/filehost.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FileHost {
  url: string;
  /** Every request's Range header, in order — how a test proves a resume actually resumed. */
  requests: Array<{ range: string | undefined }>;
  close(): Promise<void>;
}

export interface FileHostOptions {
  /**
   * 'range'    — honours Range with a 206 (the good case).
   * 'no-range' — ignores Range and always sends the whole body with a 200.
   * 'truncate' — sends half the body then destroys the socket, to force a resume.
   * 'stall'    — sends headers and one byte, then nothing, forever.
   */
  mode?: 'range' | 'no-range' | 'truncate' | 'stall';
  body?: Buffer;
  filename?: string;
}

export async function startFileHost(opts: FileHostOptions = {}): Promise<FileHost> {
  const mode = opts.mode ?? 'range';
  const body = opts.body ?? Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const filename = opts.filename ?? 'thing.bin';
  const requests: Array<{ range: string | undefined }> = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ range: req.headers.range });

    const common = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'accept-ranges': 'bytes',
    };

    if (mode === 'stall') {
      res.writeHead(200, { ...common, 'content-length': String(body.length) });
      res.write(body.subarray(0, 1));
      return; // never ends
    }

    let slice = body;
    let status = 200;
    const headers: Record<string, string> = { ...common };

    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m && mode !== 'no-range') {
      const start = Number(m[1]);
      if (start >= body.length) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }); res.end(); return; }
      slice = body.subarray(start);
      status = 206;
      headers['content-range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
    }

    if (mode === 'truncate') {
      headers['content-length'] = String(slice.length);
      res.writeHead(status, headers);
      res.write(slice.subarray(0, Math.floor(slice.length / 2)));
      res.socket?.destroy();
      return;
    }

    headers['content-length'] = String(slice.length);
    res.writeHead(status, headers);
    res.end(slice);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 2: Write the failing transfer test**

Create `test/unit/transfer.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DownloadStore } from '../../src/downloads/store.js';
import { transfer, nodeRequester } from '../../src/downloads/transfer.js';
import { startFileHost, type FileHost } from '../fixture/filehost.js';

let dir: string; let host: FileHost | undefined; let n = 0;
const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const SHA = createHash('sha256').update(BODY).digest('hex');

const mkStore = () => new DownloadStore({ dir, now: () => 1000, idgen: () => `d${++n}`, ttlMs: 1e9, maxBytes: 1e12 });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gh-xfer-')); n = 0; });
afterEach(async () => { await host?.close(); host = undefined; await rm(dir, { recursive: true, force: true }); });

describe('transfer', () => {
  it('downloads a file, hashes it, and finalises the record', async () => {
    host = await startFileHost();
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    const done = s.get(r.id)!;
    expect(done.state).toBe('done');
    expect(done.size).toBe(BODY.length);
    expect(done.received).toBe(BODY.length);
    expect(done.sha256).toBe(SHA);
    expect(done.contentType).toBe('application/octet-stream');
    expect(done.suggestedName).toBe('thing.bin');
    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    await expect(stat(s.partPath(r.id))).rejects.toThrow(); // partial renamed away
  });

  it('resumes from a partial with a Range request', async () => {
    host = await startFileHost();
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await writeFile(s.partPath(r.id), BODY.subarray(0, 10));

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    expect(host.requests[0]?.range).toBe('bytes=10-');
    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    expect(s.get(r.id)?.sha256).toBe(SHA);
  });

  // A server that ignores Range sends the whole body from zero. Appending it to the partial
  // would silently corrupt the file, so the partial must be discarded first.
  it('restarts from zero when the server ignores Range', async () => {
    host = await startFileHost({ mode: 'no-range' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await writeFile(s.partPath(r.id), BODY.subarray(0, 10));

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    expect(s.get(r.id)?.sha256).toBe(SHA);
  });

  it('keeps the partial and fails when the connection drops mid-body', async () => {
    host = await startFileHost({ mode: 'truncate' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    const rec = s.get(r.id)!;
    expect(rec.state).toBe('failed');
    expect(rec.error?.code).toBe('network');
    const part = await stat(s.partPath(r.id));
    expect(part.size).toBeGreaterThan(0);
    expect(part.size).toBeLessThan(BODY.length);
  });

  it('resuming a truncated download completes it', async () => {
    host = await startFileHost({ mode: 'truncate' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await transfer(r.id, s, nodeRequester, new AbortController().signal);
    await host.close();

    host = await startFileHost({ mode: 'range' });
    await s.update(r.id, { url: host.url, state: 'queued' });
    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    expect(s.get(r.id)?.state).toBe('done');
    expect(await readFile(s.filePath(r.id))).toEqual(BODY);
    expect(s.get(r.id)?.sha256).toBe(SHA);
  });

  it('records an http-error for a non-2xx and writes no file', async () => {
    const s = mkStore(); await s.load();
    const r = await s.create({ url: 'http://127.0.0.1:1/nope', session: 'h', referer: null });
    await transfer(r.id, s, async () => ({ status: 404, headers: {}, body: (async function* () {})(), abort() {} }), new AbortController().signal);

    expect(s.get(r.id)?.state).toBe('failed');
    expect(s.get(r.id)?.error?.code).toBe('http-error');
    await expect(stat(s.filePath(r.id))).rejects.toThrow();
  });

  it('cancels and deletes the partial when the signal aborts', async () => {
    host = await startFileHost({ mode: 'stall' });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });

    const ac = new AbortController();
    const p = transfer(r.id, s, nodeRequester, ac.signal);
    await new Promise((res) => setTimeout(res, 150));
    ac.abort();
    await p;

    expect(s.get(r.id)?.state).toBe('cancelled');
    expect(s.get(r.id)?.error?.code).toBe('cancelled');
    await expect(stat(s.partPath(r.id))).rejects.toThrow();
  });

  it('reports progress as bytes arrive', async () => {
    host = await startFileHost({ body: Buffer.alloc(200_000, 7) });
    const s = mkStore(); await s.load();
    const r = await s.create({ url: host.url, session: 'h', referer: null });
    await transfer(r.id, s, nodeRequester, new AbortController().signal);

    const rec = s.get(r.id)!;
    expect(rec.received).toBe(200_000);
    expect(rec.size).toBe(200_000);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run test/unit/transfer.test.ts`
Expected: FAIL — cannot resolve `../../src/downloads/transfer.js`

- [ ] **Step 4: Implement `src/downloads/transfer.ts`**

```ts
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DownloadStore } from './store.js';
import type { FailureCode } from './record.js';

export interface TransferResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  abort(): void;
}

export type Requester = (req: {
  url: string;
  headers: Record<string, string>;
  session: string;
}) => Promise<TransferResponse>;

function coded(code: FailureCode, message: string): { code: FailureCode; message: string } {
  return { code, message };
}

/** RFC 6266, both the plain and the RFC 5987 forms. Metadata only — never a path. */
function suggestedNameFrom(headers: Record<string, string>, url: string): string | null {
  const cd = headers['content-disposition'];
  if (cd) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through */ } }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(cd) ?? /filename\s*=\s*([^;]+)/i.exec(cd);
    if (plain) return plain[1]!.trim();
  }
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch { return null; }
}

/**
 * Stream one download into `<id>.part`, then rename to `<id>.bin`.
 *
 * Resume: if a partial exists we ask for `bytes=N-`. A 206 means append; a **200 means the
 * server ignored us and is sending from zero**, so the partial must be discarded — appending
 * would silently corrupt the file, and a corrupt multi-GB ISO is expensive to discover.
 *
 * Hashing happens in a final pass over the finished file rather than while streaming. Streaming
 * cannot carry a partial hash across a process restart, and one extra local read is cheaper
 * than a hash that is wrong after a resume.
 */
export async function transfer(
  id: string,
  store: DownloadStore,
  request: Requester,
  signal: AbortSignal,
): Promise<void> {
  const rec = store.get(id);
  if (!rec) return;

  const part = store.partPath(id);
  let have = 0;
  try { have = (await stat(part)).size; } catch { /* no partial */ }

  const headers: Record<string, string> = {};
  if (have > 0) headers['range'] = `bytes=${have}-`;
  if (rec.referer) headers['referer'] = rec.referer;

  await store.update(id, { state: 'running' });

  let res: TransferResponse;
  try {
    res = await request({ url: rec.url, headers, session: rec.session });
  } catch (e: unknown) {
    await store.update(id, { state: 'failed', error: coded('network', e instanceof Error ? e.message : String(e)) });
    return;
  }

  const onAbort = () => res.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (res.status < 200 || res.status >= 300) {
      await store.update(id, { state: 'failed', error: coded('http-error', `server answered ${res.status}`) });
      return;
    }

    // 200 to a Range request means the server ignored it: start over.
    const appending = have > 0 && res.status === 206;
    if (have > 0 && !appending) { await rm(part, { force: true }); have = 0; }

    const declared = Number(res.headers['content-length'] ?? '');
    const total = Number.isFinite(declared) && declared >= 0 ? have + declared : -1;
    await store.update(id, {
      size: total,
      received: have,
      contentType: res.headers['content-type'] ?? null,
      suggestedName: suggestedNameFrom(res.headers, rec.url),
    });

    const out = createWriteStream(part, { flags: appending ? 'a' : 'w' });
    let received = have;
    let sinceReport = 0;

    try {
      for await (const chunk of res.body) {
        if (signal.aborted) break;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
        received += chunk.byteLength;
        sinceReport += chunk.byteLength;
        // Progress is persisted, so throttle it — a per-chunk manifest write on a 4GB file
        // would be tens of thousands of fsyncs.
        if (sinceReport >= 4 * 1024 * 1024) { sinceReport = 0; await store.update(id, { received }); }
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }

    if (signal.aborted) {
      await rm(part, { force: true });
      await store.update(id, { state: 'cancelled', received, error: coded('cancelled', 'cancelled by the caller') });
      return;
    }

    if (total >= 0 && received !== total) {
      await store.update(id, { state: 'failed', received, error: coded('network', `expected ${total} bytes, received ${received}`) });
      return;
    }

    const sha256 = await hashFile(part);
    await rename(part, store.filePath(id));
    const now = store.nowMs();
    await store.update(id, {
      state: 'done', received, size: received, sha256,
      completedAt: now, lastAccessAt: now,
    });
  } catch (e: unknown) {
    if (signal.aborted) {
      await rm(part, { force: true });
      await store.update(id, { state: 'cancelled', error: coded('cancelled', 'cancelled by the caller') });
      return;
    }
    // The partial is deliberately KEPT: a later attempt resumes from it.
    await store.update(id, { state: 'failed', error: coded('network', e instanceof Error ? e.message : String(e)) });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Uint8Array);
  return h.digest('hex');
}

/**
 * A `Requester` over Node's own http/https. This is the TEST path — production uses Electron's
 * `net` on the site's partition, which carries that partition's cookies and Chrome's TLS
 * fingerprint. Keeping both behind one narrow interface is what lets the transfer logic be
 * tested without a browser.
 */
export const nodeRequester: Requester = async ({ url, headers }) => {
  const mod = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<TransferResponse>((resolve, reject) => {
    const req = mod(url, { headers }, (res) => {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      resolve({ status: res.statusCode ?? 0, headers: flat, body: res, abort: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
};
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npx vitest run test/unit/transfer.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Mutation-check the corruption guard**

This is the guard that prevents silently corrupting a multi-GB file. Change `const appending = have > 0 && res.status === 206;` to `const appending = have > 0;`, run `npx vitest run test/unit/transfer.test.ts`, and confirm `restarts from zero when the server ignores Range` goes RED (the file will be longer than `BODY` and the hash will differ). Restore, confirm green. Record both outputs.

- [ ] **Step 7: Commit**

```bash
git add src/downloads/transfer.ts test/fixture/filehost.ts test/unit/transfer.test.ts
git commit -m "feat: streaming transfer with resume, cancel and hashing

A 200 in reply to a Range request means the server ignored it and is sending
from zero, so the partial is discarded rather than appended to — appending
would silently corrupt the file, and a corrupt multi-GB ISO is expensive to
discover. Hashing is a final pass over the finished file: a streaming hash
cannot survive a resume, and one extra local read beats a wrong digest.

A failure keeps the partial so a later attempt can resume; a cancel deletes it."
```

---

### Task 5: Shared target validation and the `/gh/*` handlers

**Files:**
- Create: `src/api/target.ts`, `src/api/gh.ts`
- Modify: `src/api/v1.ts` (use the extracted validator — no behaviour change)
- Test: `test/unit/target.test.ts`, `test/unit/gh.test.ts`

**Interfaces:**
- Consumes: `DownloadStore` (Task 2), `serveFile` (Task 3), `SESSION_NAME` (increment 1)
- Produces:
  - `type TargetError = { message: string }`
  - `function validateTarget(rawUrl: unknown, rawSession: unknown): { url: string; session: string } | TargetError`
  - `function isTargetError(x: unknown): x is TargetError`
  - `interface GhDeps { store: DownloadStore; submit: (id: string) => void; cancel: (id: string) => void; now: () => number }`
  - `function handleGh(req: IncomingMessage, res: ServerResponse, path: string, deps: GhDeps): Promise<boolean>` — returns `false` when the path is not ours

- [ ] **Step 1: Write the failing target test**

Create `test/unit/target.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateTarget, isTargetError } from '../../src/api/target.js';

describe('validateTarget', () => {
  it('accepts an http and an https url and derives a session', () => {
    expect(validateTarget('http://example.test/a', undefined)).toEqual({ url: 'http://example.test/a', session: 'example.test' });
    expect(validateTarget('https://example.test/a', undefined)).toEqual({ url: 'https://example.test/a', session: 'example.test' });
  });
  it('honours an explicit valid session', () => {
    expect(validateTarget('http://example.test/a', 'vimm')).toEqual({ url: 'http://example.test/a', session: 'vimm' });
  });
  it('forwards the parsed href, not the raw string', () => {
    const r = validateTarget('http://example.test', undefined);
    expect(isTargetError(r) ? '' : r.url).toBe('http://example.test/');
  });
  it('rejects a non-http scheme', () => {
    for (const u of ['file:///C:/x', 'mailto:a@b.c', 'data:text/html,x', 'about:blank']) {
      const r = validateTarget(u, undefined);
      expect(isTargetError(r)).toBe(true);
    }
  });
  it('rejects an unparseable url and a non-string', () => {
    expect(isTargetError(validateTarget('not a url', undefined))).toBe(true);
    expect(isTargetError(validateTarget(42, undefined))).toBe(true);
    expect(isTargetError(validateTarget('', undefined))).toBe(true);
  });
  it('rejects a hostile session name', () => {
    for (const s of ['../../x', 'a\\b', 'a:b', '..', '.', 'x'.repeat(65)]) {
      expect(isTargetError(validateTarget('http://example.test/a', s))).toBe(true);
    }
  });
  it('sanitizes a derived session that is not a legal name', () => {
    const r = validateTarget('http://[::1]:8080/a', undefined);
    expect(isTargetError(r)).toBe(false);
    expect(isTargetError(r) ? '' : r.session).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/target.test.ts`
Expected: FAIL — cannot resolve `../../src/api/target.js`

- [ ] **Step 3: Implement `src/api/target.ts` by moving the logic out of `v1.ts`**

Move `SESSION_NAME`, the all-dots check, `sanitizeSession` and `sessionFor` out of `src/api/v1.ts` into `src/api/target.ts`, re-exporting `SESSION_NAME` from `v1.ts` so nothing that imports it breaks. Then add:

```ts
export interface TargetError { message: string }

export function isTargetError(x: unknown): x is TargetError {
  return typeof x === 'object' && x !== null && 'message' in x && !('url' in x);
}

/**
 * The single gate for "what may we point a browser at, and under what partition name".
 *
 * It lives here rather than in `v1.ts` because `/gh/fetch` needs exactly the same answer, and
 * two copies of a security check drift. A caller-supplied session is REJECTED when malformed;
 * a derived one is SANITIZED — the caller can fix their own input, but a hostname is not
 * theirs to fix.
 */
export function validateTarget(rawUrl: unknown, rawSession: unknown): { url: string; session: string } | TargetError {
  if (typeof rawUrl !== 'string' || rawUrl === '') return { message: 'url is required and must be a string' };

  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return { message: `url is not a valid URL: ${rawUrl}` }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { message: `url scheme ${parsed.protocol} is not supported; only http and https are` };
  }

  const supplied = typeof rawSession === 'string' && rawSession ? rawSession : '';
  if (supplied && !validSession(supplied)) return { message: badSession(supplied) };

  return { url: parsed.href, session: supplied || (parsed.hostname ? sanitizeSession(parsed.hostname) : 'default') };
}
```

`v1.ts`'s `request.*` arm now calls `validateTarget` and returns `fail(...)` with the message on error. Its existing tests must keep passing unchanged — that is the check that the extraction was behaviour-preserving.

- [ ] **Step 4: Run the target and v1 tests**

Run: `npx vitest run test/unit/target.test.ts test/unit/v1.test.ts`
Expected: PASS — target file 7 tests, v1 file 29 tests, all unchanged

- [ ] **Step 5: Write the failing `/gh/*` test**

Create `test/unit/gh.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadStore } from '../../src/downloads/store.js';
import { handleGh, type GhDeps } from '../../src/api/gh.js';

let dir: string; let server: Server; let base: string; let store: DownloadStore;
let submitted: string[]; let cancelled: string[]; let n = 0; let clock = 1000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-api-')); n = 0; clock = 1000;
  submitted = []; cancelled = [];
  store = new DownloadStore({ dir, now: () => clock, idgen: () => `d${++n}`, ttlMs: 1e9, maxBytes: 1e12 });
  await store.load();
  const deps: GhDeps = { store, submit: (id) => submitted.push(id), cancel: (id) => cancelled.push(id), now: () => clock };
  server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (!(await handleGh(req, res, path, deps))) { res.writeHead(404); res.end(); }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${base}/gh/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /gh/fetch', () => {
  it('answers 202 with a job id and schedules the work', async () => {
    const res = await post({ url: 'http://example.test/f.bin' });
    expect(res.status).toBe(202);
    const body = await res.json() as any;
    expect(body.jobId).toBe('d1');
    expect(body.state).toBe('queued');
    expect(submitted).toEqual(['d1']);
    expect(store.get('d1')?.session).toBe('example.test');
  });

  it('dedupes an in-flight request for the same target', async () => {
    await post({ url: 'http://example.test/f.bin' });
    const again = await post({ url: 'http://example.test/f.bin' });
    expect(((await again.json()) as any).jobId).toBe('d1');
    expect(submitted).toEqual(['d1']); // scheduled once, not twice
  });

  it('rejects a file: url with our error shape', async () => {
    const res = await post({ url: 'file:///C:/secrets.txt' });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toMatch(/scheme/);
    expect(submitted).toEqual([]);
  });

  it('rejects a hostile session name', async () => {
    const res = await post({ url: 'http://example.test/f.bin', site: '../../etc' });
    expect(res.status).toBe(400);
    expect(submitted).toEqual([]);
  });

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${base}/gh/fetch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    expect(res.status).toBe(400);
  });

  it('405s a GET', async () => {
    expect((await fetch(`${base}/gh/fetch`)).status).toBe(405);
  });
});

describe('GET /gh/jobs/:id', () => {
  it('reports progress for a running download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'running', size: 100, received: 40 });
    const body = await (await fetch(`${base}/gh/jobs/d1`)).json() as any;
    expect(body.state).toBe('running');
    expect(body.progress).toEqual({ received: 40, total: 100 });
    expect(body.result).toBeUndefined();
  });

  it('returns path, url, size and sha256 for a completed download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'done', size: 3, received: 3, sha256: 'aa', suggestedName: 'f.bin', contentType: 'application/zip' });
    const body = await (await fetch(`${base}/gh/jobs/d1`)).json() as any;
    expect(body.state).toBe('done');
    expect(body.result.path).toBe(store.filePath('d1'));
    expect(body.result.url).toBe('/gh/files/d1');
    expect(body.result.size).toBe(3);
    expect(body.result.sha256).toBe('aa');
    expect(body.result.filename).toBe('f.bin');
  });

  it('reports the failure code for a failed download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'failed', error: { code: 'http-error', message: 'server answered 404' } });
    const body = await (await fetch(`${base}/gh/jobs/d1`)).json() as any;
    expect(body.state).toBe('failed');
    expect(body.error).toEqual({ code: 'http-error', message: 'server answered 404' });
  });

  it('404s an unknown id', async () => {
    const res = await fetch(`${base}/gh/jobs/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe('not-found');
  });
});

describe('DELETE /gh/jobs/:id', () => {
  it('cancels an in-flight download', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'running' });
    const res = await fetch(`${base}/gh/jobs/d1`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(cancelled).toEqual(['d1']);
  });

  it('releases a completed download and its bytes', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await writeFile(store.filePath('d1'), 'abc');
    await store.update('d1', { state: 'done', size: 3, received: 3 });
    expect((await fetch(`${base}/gh/jobs/d1`, { method: 'DELETE' })).status).toBe(204);
    expect(store.get('d1')).toBeUndefined();
    expect((await fetch(`${base}/gh/jobs/d1`)).status).toBe(404);
  });

  it('404s an unknown id', async () => {
    expect((await fetch(`${base}/gh/jobs/nope`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /gh/files/:id', () => {
  it('serves the bytes with Range support and bumps lastAccessAt', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await writeFile(store.filePath('d1'), '0123456789');
    await store.update('d1', { state: 'done', size: 10, received: 10, suggestedName: 'f.bin', lastAccessAt: 1000 });

    clock = 5000;
    const whole = await fetch(`${base}/gh/files/d1`);
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('0123456789');
    expect(store.get('d1')?.lastAccessAt).toBe(5000);

    const part = await fetch(`${base}/gh/files/d1`, { headers: { range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('234');
  });

  it('409s a download that is not finished', async () => {
    await post({ url: 'http://example.test/f.bin' });
    await store.update('d1', { state: 'running' });
    const res = await fetch(`${base}/gh/files/d1`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe('not-ready');
  });

  it('404s an unknown id', async () => {
    expect((await fetch(`${base}/gh/files/nope`)).status).toBe(404);
  });

  // The id indexes a map we populated. It must never be joined into a path.
  it('cannot be path-traversed through the id', async () => {
    for (const id of ['..%2F..%2Fmanifest.json', '..', '%2e%2e%2f%2e%2e%2fmanifest.json']) {
      const res = await fetch(`${base}/gh/files/${id}`);
      expect([404, 400]).toContain(res.status);
    }
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npx vitest run test/unit/gh.test.ts`
Expected: FAIL — cannot resolve `../../src/api/gh.js`

- [ ] **Step 7: Implement `src/api/gh.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import type { DownloadStore } from '../downloads/store.js';
import { isSettled } from '../downloads/record.js';
import { serveFile } from './range.js';
import { validateTarget, isTargetError } from './target.js';

export interface GhDeps {
  store: DownloadStore;
  /** Hand the id to the download queue. */
  submit: (id: string) => void;
  /** Abort an in-flight transfer. */
  cancel: (id: string) => void;
  now: () => number;
}

type GhCode = 'bad-request' | 'not-found' | 'not-ready' | 'internal';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** `/gh/*` uses OUR error shape. `/v1` keeps FlareSolverr's — they are different contracts. */
function sendError(res: ServerResponse, status: number, code: GhCode, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { settled = true; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', () => { if (!settled) { settled = true; resolve(null); } });
  });
}

/**
 * Handle a `/gh/*` request. Returns false when `path` is not one of ours, so the caller's
 * router can fall through to its own 404.
 */
export async function handleGh(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: GhDeps,
): Promise<boolean> {
  if (path === '/gh/fetch') {
    if (req.method !== 'POST') { sendError(res, 405, 'bad-request', 'POST only'); return true; }
    await postFetch(req, res, deps);
    return true;
  }

  const job = /^\/gh\/jobs\/([^/]+)$/.exec(path);
  if (job) {
    // decodeURIComponent so an encoded traversal attempt is compared as the literal it is; the
    // id is only ever a MAP KEY, never joined into a path, so a miss is simply 404.
    const id = safeDecode(job[1]!);
    if (req.method === 'GET') { getJob(res, id, deps); return true; }
    if (req.method === 'DELETE') { await deleteJob(res, id, deps); return true; }
    sendError(res, 405, 'bad-request', 'GET or DELETE only');
    return true;
  }

  const file = /^\/gh\/files\/([^/]+)$/.exec(path);
  if (file) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendError(res, 405, 'bad-request', 'GET or HEAD only'); return true; }
    await getFile(req, res, safeDecode(file[1]!), deps);
    return true;
  }

  return false;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

async function postFetch(req: IncomingMessage, res: ServerResponse, deps: GhDeps): Promise<void> {
  const raw = await readBody(req);
  if (raw === null) { sendError(res, 400, 'bad-request', 'request body was unreadable or too large'); return; }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'bad-request', 'request body must be a JSON object');
    return;
  }

  const target = validateTarget(body.url, body.site);
  if (isTargetError(target)) { sendError(res, 400, 'bad-request', target.message); return; }

  const open = deps.store.findOpen(target.session, target.url);
  if (open) { sendJson(res, 202, { jobId: open.id, state: open.state }); return; }

  const referer = typeof body.referer === 'string' ? body.referer : null;
  const rec = await deps.store.create({ url: target.url, session: target.session, referer });
  deps.submit(rec.id);
  sendJson(res, 202, { jobId: rec.id, state: rec.state });
}

function getJob(res: ServerResponse, id: string, deps: GhDeps): void {
  const rec = deps.store.get(id);
  if (!rec) { sendError(res, 404, 'not-found', `no such job: ${id}`); return; }

  const body: Record<string, unknown> = {
    state: rec.state,
    progress: { received: rec.received, total: rec.size },
  };
  if (rec.state === 'done') {
    body.result = {
      path: deps.store.filePath(rec.id),
      url: `/gh/files/${rec.id}`,
      size: rec.size,
      sha256: rec.sha256,
      filename: rec.suggestedName,
      contentType: rec.contentType,
    };
  }
  if (rec.error) body.error = rec.error;
  sendJson(res, 200, body);
}

async function deleteJob(res: ServerResponse, id: string, deps: GhDeps): Promise<void> {
  const rec = deps.store.get(id);
  if (!rec) { sendError(res, 404, 'not-found', `no such job: ${id}`); return; }

  if (!isSettled(rec.state)) {
    // Cancelling is asynchronous: the transfer notices the abort, deletes its partial, and
    // marks the record cancelled. Removing the record here would race that.
    deps.cancel(id);
  } else {
    await deps.store.remove(id);
  }
  res.writeHead(204);
  res.end();
}

async function getFile(req: IncomingMessage, res: ServerResponse, id: string, deps: GhDeps): Promise<void> {
  const rec = deps.store.get(id);
  if (!rec) { sendError(res, 404, 'not-found', `no such job: ${id}`); return; }
  if (rec.state !== 'done') { sendError(res, 409, 'not-ready', `job ${id} is ${rec.state}`); return; }

  const path = deps.store.filePath(id);
  let size: number;
  try { size = (await stat(path)).size; } catch { sendError(res, 404, 'not-found', `bytes for ${id} are gone`); return; }

  await deps.store.touch(id);
  await serveFile(req, res, { path, size, contentType: rec.contentType, filename: rec.suggestedName });
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `npx vitest run test/unit/gh.test.ts`
Expected: PASS, 17 tests

- [ ] **Step 9: Commit**

```bash
git add src/api/target.ts src/api/gh.ts src/api/v1.ts test/unit/target.test.ts test/unit/gh.test.ts
git commit -m "feat: /gh/fetch, job polling and file serving

Target validation moves into one module both /v1 and /gh/fetch call, because
two copies of a security check drift. A caller-supplied session is rejected
when malformed while a derived one is sanitized — the caller can fix their own
input, a hostname is not theirs to fix.

Cancelling an in-flight job is asynchronous: the transfer notices the abort,
deletes its partial and marks the record. Removing the record here would race
that. A settled job's DELETE releases the bytes immediately."
```

---

### Task 6: Wire it up, and prove it end to end

**Files:**
- Modify: `src/api/server.ts`, `src/main.ts`, `README.md`
- Create: `test/integration/download.test.ts`
- Test: `test/unit/server.test.ts` (extend)

**Interfaces:**
- Consumes: everything above
- Produces:
  - `startServer(cfg, deps, health, gh?: GhDeps)` — `gh` optional so increment 1's server tests need no store
  - `electronRequester(session: string): Requester` in `src/main.ts`

- [ ] **Step 1: Route `/gh/*` in `src/api/server.ts`**

Add the optional dependency to the signature and route before the final 404:

```ts
export async function startServer(
  cfg: GatehouseConfig,
  deps: V1Deps,
  health: () => object,
  gh?: GhDeps,
): Promise<ServerHandle> {
```

and inside the handler, after the `/v1` branch:

```ts
        // `/gh/*` is only mounted when a store was wired in. Increment 1's server tests pass
        // no `gh`, and must keep getting the router's own 404 for these paths.
        if (gh && (await handleGh(req, res, path, gh))) return;
```

Add to `test/unit/server.test.ts`:

```ts
  it('404s /gh/fetch when no download store is wired in', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/gh/fetch`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 2: Run the server tests**

Run: `npx vitest run test/unit/server.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 3: Wire `src/main.ts`**

Add, after the existing solver wiring:

```ts
import { app, net, session as electronSession } from 'electron';
import { DownloadStore } from './downloads/store.js';
import { transfer, type Requester, type TransferResponse } from './downloads/transfer.js';
import { handleGh, type GhDeps } from './api/gh.js';
import { join } from 'node:path';

/**
 * A `Requester` over Electron's `net` on a named partition — this is the point of the whole
 * increment: the bytes come down the same session that solved the challenge, carrying that
 * partition's cookies and Chrome's TLS fingerprint rather than Node's.
 */
function electronRequester(): Requester {
  return async ({ url, headers, session }) =>
    new Promise<TransferResponse>((resolve, reject) => {
      const req = net.request({ url, session: electronSession.fromPartition(`persist:${session}`) });
      for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
      req.on('response', (res) => {
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        resolve({
          status: res.statusCode,
          headers: flat,
          body: res as unknown as AsyncIterable<Uint8Array>,
          abort: () => req.abort(),
        });
      });
      req.on('error', reject);
      req.end();
    });
}
```

and in `start()`:

```ts
  const downloadsDir = cfg.downloadsDir || join(app.getPath('userData'), 'downloads');
  const store = new DownloadStore({
    dir: downloadsDir,
    now: () => Date.now(),
    idgen: () => randomUUID(),
    ttlMs: cfg.downloadTtlMs,
    maxBytes: cfg.downloadMaxBytes,
  });
  await store.load();
  await store.sweep();

  const aborts = new Map<string, AbortController>();
  const request = electronRequester();

  const downloads = new JobQueue<string, void>({
    concurrency: cfg.downloadConcurrency,
    idgen: () => randomUUID(),
    now: () => Date.now(),
    run: async (id) => {
      const ac = new AbortController();
      aborts.set(id, ac);
      try { await transfer(id, store, request, ac.signal); }
      finally { aborts.delete(id); await store.sweep(); }
    },
  });

  const ghDeps: GhDeps = {
    store,
    submit: (id) => { downloads.submit(`dl\u0000${id}`, id); },
    cancel: (id) => { aborts.get(id)?.abort(); },
    now: () => Date.now(),
  };
```

Pass `ghDeps` as `startServer`'s fourth argument, and extend `health` with
`downloads: { active: downloads.busy, records: store.all().length }`.

- [ ] **Step 4: Write the end-to-end integration test**

Create `test/integration/download.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startGatehouse, type Harness } from './harness.js';
import { startFileHost, type FileHost } from '../fixture/filehost.js';

let gh: Harness; let host: FileHost; let dir: string;
const BODY = Buffer.alloc(3 * 1024 * 1024, 42); // 3MB, so progress is observable
const SHA = createHash('sha256').update(BODY).digest('hex');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-dl-'));
  gh = await startGatehouse({ GATEHOUSE_DOWNLOADS_DIR: dir });
  host = await startFileHost({ body: BODY, filename: 'payload.bin' });
}, 60_000);
afterAll(async () => {
  await gh?.stop(); await host?.close();
  await rm(dir, { recursive: true, force: true });
});

const poll = async (id: string, want: string, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = await (await fetch(`${gh.url}/gh/jobs/${id}`)).json() as any;
    if (body.state === want) return body;
    if (['done', 'failed', 'cancelled'].includes(body.state)) return body;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${body.state}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

describe('downloading through the real app', () => {
  let id: string;

  it('accepts a fetch and completes it', async () => {
    const res = await fetch(`${gh.url}/gh/fetch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: host.url, site: 'filehost' }),
    });
    expect(res.status).toBe(202);
    id = ((await res.json()) as any).jobId;

    const done = await poll(id, 'done');
    expect(done.state).toBe('done');
    expect(done.result.size).toBe(BODY.length);
    expect(done.result.sha256).toBe(SHA);
    expect(done.result.filename).toBe('payload.bin');

    // The local path is real and the right size — the zero-copy case.
    expect((await stat(done.result.path)).size).toBe(BODY.length);
  }, 60_000);

  it('serves the bytes back, with Range', async () => {
    const whole = await fetch(`${gh.url}/gh/files/${id}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await whole.arrayBuffer()).equals(BODY)).toBe(true);

    const part = await fetch(`${gh.url}/gh/files/${id}`, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100-199/${BODY.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(BODY.subarray(100, 200))).toBe(true);
  }, 60_000);

  it('releases the bytes on DELETE', async () => {
    const path = ((await (await fetch(`${gh.url}/gh/jobs/${id}`)).json()) as any).result.path;
    expect((await fetch(`${gh.url}/gh/jobs/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${gh.url}/gh/jobs/${id}`)).status).toBe(404);
    await expect(stat(path)).rejects.toThrow();
  }, 60_000);

  it('cancels an in-flight download and leaves no partial', async () => {
    const stallHost = await startFileHost({ mode: 'stall' });
    try {
      const res = await fetch(`${gh.url}/gh/fetch`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: stallHost.url, site: 'stall' }),
      });
      const stallId = ((await res.json()) as any).jobId;
      await new Promise((r) => setTimeout(r, 500));

      expect((await fetch(`${gh.url}/gh/jobs/${stallId}`, { method: 'DELETE' })).status).toBe(204);
      const settled = await poll(stallId, 'cancelled', 15_000);
      expect(settled.state).toBe('cancelled');
    } finally {
      await stallHost.close();
    }
  }, 60_000);

  it('reports downloads in health', async () => {
    const h = await (await fetch(`${gh.url}/gh/health`)).json() as any;
    expect(h.downloads).toBeDefined();
    expect(typeof h.downloads.active).toBe('number');
  });
});
```

- [ ] **Step 5: Build and run the integration test**

```bash
npx tsc
npx vitest run test/integration/download.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — 135 from increment 1 plus roughly 68 new.

- [ ] **Step 7: Update `README.md`**

Add a `## Downloading` section documenting: `POST /gh/fetch` (`{url, site?, referer?}` → `202 {jobId, state}`), `GET /gh/jobs/:id`, `DELETE /gh/jobs/:id`, `GET /gh/files/:id`, the `{"error":{"code","message"}}` shape and why it differs from `/v1`'s, and the four new env vars with their defaults and ranges. State plainly that the retention sweep can delete a completed download that was never released, and that this has **not** been exercised against a multi-GB file or a real content source.

- [ ] **Step 8: Commit**

```bash
git add src/api/server.ts src/main.ts README.md test/integration/download.test.ts test/unit/server.test.ts
git commit -m "feat: wire /gh/* into the server and the Electron net requester

The bytes come down the same partition that solved the challenge, so they carry
its cookies and Chrome's TLS fingerprint rather than Node's — which is the
point of routing downloads through the browser at all.

/gh/* is mounted only when a store is wired in, so increment 1's server tests
still get the router's own 404 for those paths."
```

---

## Self-Review

**Spec coverage.** Increment 2's row in the design reads: "`/gh/fetch`, job polling, Range file server, resume/cancel/dedupe — a large file downloads through a solved session, survives a restart, cancels cleanly." Mapping: `/gh/fetch` (5, 6), job polling (5), Range file server (3, 5), resume (4), cancel (4, 5, 6), dedupe (2, 5). Survives a restart: the store's manifest reload (2) plus the resume-from-partial path (4); a record left `running` is demoted on load so it cannot block dedupe forever.

Spec requirements also covered: both a local `path` and an HTTP `url` in the result (5); the download-to-disk-then-serve shape (4, 5); `disk-full`/`cancelled`/`http-error` reaching the caller (4); the boundary that Gatehouse fetches URLs and does not know site flows (target validation takes a URL and a referer, nothing more).

**Deliberately deferred, and why:** the `session.will-download` escape hatch. The spec lists it as the path for a URL that only materialises from a page action, and nothing in this increment's acceptance needs it — Allarr derives final URLs itself. Building it now would be guessing at a shape no real site has yet forced. Recorded as a decision, not an oversight.

**Type consistency.** `DownloadRecord`/`DownloadState`/`isSettled`/`isReclaimable` are defined once in `record.ts` and imported by `store.ts`, `transfer.ts` and `gh.ts`. `Requester`/`TransferResponse` once in `transfer.ts`, implemented twice (`nodeRequester` for tests, `electronRequester` in `main.ts`). `GhDeps` once in `gh.ts`, consumed by `server.ts` and `main.ts`. `validateTarget` once in `target.ts`, called by both `v1.ts` and `gh.ts` — `SESSION_NAME` is re-exported from `v1.ts` so increment 1's importers do not break. `FailureCode` still has its single home in `jobs/queue.ts`.

**One judgement call flagged for the reviewer.** Hashing is a second pass over the finished file rather than a streaming digest. That costs one extra local read of a multi-GB file. The alternative — a streaming hash — cannot survive a resume or a restart, and a wrong `sha256` is worse than a slow one. If a reviewer disagrees, the fix is to stream-hash only when `have === 0` and fall back to a pass otherwise; I judged the branch not worth the complexity, but it is a real trade and not an oversight.
