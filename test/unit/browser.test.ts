import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, appendFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowserWindow, DownloadItem, Session, WebContents } from 'electron';
import { DownloadStore } from '../../src/downloads/store.js';
import { browserDownload, type BrowserDownloadDeps } from '../../src/downloads/browser.js';
import type { DownloadRecord } from '../../src/downloads/record.js';

/**
 * The download engine, driven against a FAKE Electron session and download item.
 *
 * It can be: `browser.ts` imports `electron` for TYPES only and takes its session, its window
 * factory and its store as injected dependencies, so everything below is the real engine — the
 * real store, real files on a real temp directory — with only the browser replaced.
 *
 * That replacement is exactly what buys the coverage here. The integration suite drives the
 * shipped app against a fixture HTTP host and cannot reach any of this:
 *
 * - **The resume branch** needs `session.createInterruptedDownload` to emit `will-download`
 *   *synchronously inside the call*, which is the undocumented behaviour the whole resume
 *   correlation rests on. A fake session is the only way to assert the one-shot is armed and
 *   removed, that the tripwire refuses an item whose save path is not ours, and what happens
 *   when the call produces no item at all. Reaching it end-to-end would mean killing the app
 *   mid-body against a host that sends a validator — see the README's "not proven".
 * - **`ENOSPC` → `disk-full`** cannot be provoked by an HTTP fixture at all: it needs a full
 *   disk, or a stubbed failure.
 * - **A foreign interrupt that leaves a partial on disk** needs the writer to interrupt with
 *   bytes already written, which the fixture host has no way to arrange for Chromium.
 *
 * What this deliberately does NOT claim: that Chromium behaves the way the fakes do. The fakes
 * encode the measured behaviour the engine was written against, and `browser-download.test.ts`
 * is what holds the real thing to it.
 */

const BODY = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz0123456789');
const HALF = BODY.subarray(0, 20);
const SHA = createHash('sha256').update(BODY).digest('hex');

let dir: string;
let clock = 1000;
let store: DownloadStore;
/**
 * The session this test's window is paired with.
 *
 * The engine asks for the partition and the window through two separate deps, but
 * `will-download` fires on the SESSION carrying the WINDOW's `webContents` — that argument is
 * the only thing that correlates a fresh download to its job. So a fake has to hand both out of
 * one place, and this is it.
 */
let currentSession: FakeSession;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-engine-'));
  clock = 1000;
  currentSession = new FakeSession();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const mkStore = (id: string): DownloadStore =>
  new DownloadStore({ dir, now: () => clock, idgen: () => id, ttlMs: 600_000, maxBytes: 1e9 });

interface ItemOptions {
  received?: number;
  totalBytes?: number;
  eTag?: string;
  savePath?: string;
  /** Called by `resume()`, so a fake can act the way a resumed item does: it does nothing
   *  at all until asked, and then it either finishes or does not. */
  onResume?: (item: FakeItem) => void;
}

/** A `DownloadItem` with the getters the engine actually reads, and nothing else. */
class FakeItem extends EventEmitter {
  savePath: string;
  cancelled = 0;
  resumed = 0;
  constructor(private readonly o: ItemOptions = {}) {
    super();
    this.savePath = o.savePath ?? '';
  }
  setSavePath(p: string): void { this.savePath = p; }
  getSavePath(): string { return this.savePath; }
  getReceivedBytes(): number { return this.o.received ?? 0; }
  getFilename(): string { return 'payload.bin'; }
  getMimeType(): string { return 'application/octet-stream'; }
  getTotalBytes(): number { return this.o.totalBytes ?? 0; }
  getURLChain(): string[] { return ['http://x.test/payload.bin']; }
  getETag(): string { return this.o.eTag ?? ''; }
  getLastModifiedTime(): string { return ''; }
  // Fractional on purpose: Chromium reports one and rejects one, so the engine floors it.
  getStartTime(): number { return 1_700_000_000.75; }
  cancel(): void { this.cancelled += 1; }
  resume(): void { this.resumed += 1; this.o.onResume?.(this); }
  /** What Chromium's own `done` is: the file is closed by the time this fires. */
  finish(state: string): void { this.emit('done', {}, state); }
  get item(): DownloadItem { return this as unknown as DownloadItem; }
}

interface ResumeCall {
  path: string;
  offset: number;
  length: number;
  eTag: string;
  lastModified: string;
  urlChain: string[];
  mimeType: string;
  startTime: number;
}

/** A `Session`: an emitter, plus the one resume API, which is session-scoped by design. */
class FakeSession extends EventEmitter {
  readonly resumeCalls: ResumeCall[] = [];
  constructor(private readonly onResumeCall?: (s: FakeSession, c: ResumeCall) => void) { super(); }
  createInterruptedDownload(opts: ResumeCall): void {
    this.resumeCalls.push(opts);
    this.onResumeCall?.(this, opts);
  }
  get session(): Session { return this as unknown as Session; }
}

interface FakeWindow {
  webContents: WebContents;
  destroyed: number;
  window: BrowserWindow;
}

/** A hidden window whose only job is to own a `webContents` identity and a `downloadURL`. */
function fakeWindow(downloadURL: (self: FakeWindow, url: string) => void): FakeWindow {
  const self = {
    webContents: null as unknown as WebContents,
    destroyed: 0,
  } as FakeWindow;
  self.webContents = {
    downloadURL: (url: string) => downloadURL(self, url),
  } as unknown as WebContents;
  self.window = {
    webContents: self.webContents,
    isDestroyed: () => self.destroyed > 0,
    destroy: () => { self.destroyed += 1; },
  } as unknown as BrowserWindow;
  return self;
}

/** A store on this test's temp directory, plus one record in it under a known id. */
async function seed(
  id: string,
  patch: Partial<DownloadRecord> = {},
): Promise<DownloadRecord> {
  store = mkStore(id);
  const rec = await store.create({ url: 'http://x.test/payload.bin', session: 'x.test', referer: null });
  if (Object.keys(patch).length > 0) await store.update(id, patch);
  return rec;
}

/**
 * `makeWindow` has no default on purpose: every test says what its browser does, and a default
 * that quietly did nothing would let a test pass by never starting a download at all.
 */
type Overrides = Partial<BrowserDownloadDeps> & Pick<BrowserDownloadDeps, 'makeWindow'>;

const run = (id: string, over: Overrides): Promise<void> =>
  browserDownload(
    id,
    {
      store,
      partitionFor: () => currentSession.session,
      noStartMs: 60_000,
      stallMs: 120_000,
      ...over,
    },
    new AbortController().signal,
  );

const files = async (id: string): Promise<string[]> =>
  (await readdir(dir)).filter((f) => f.startsWith(id)).sort();

describe('a download that fails', () => {
  /**
   * The retention sweep ages a record from `completedAt ?? createdAt`. A failure that left
   * `completedAt` null would therefore be aged from the moment the download STARTED — so a
   * download that ran for longer than the TTL before dying would be reclaimable the instant it
   * settled, and its record could vanish out from under a caller that had not polled yet.
   */
  it('stamps completedAt, so the TTL runs from the failure and not from the start', async () => {
    const id = 'fail-1';
    const rec = await seed(id);
    expect(rec.createdAt).toBe(1000);
    clock = 90_000; // the download took a while before the far end gave up

    await run(id, {
      makeWindow: () => fakeWindow((self) => {
        const dl = new FakeItem();
        currentSession.emit('will-download', {}, dl.item, self.webContents);
        dl.finish('interrupted');
      }).window,
    });

    const after = store.get(id)!;
    expect(after.state).toBe('failed');
    expect(after.error!.code).toBe('network');
    expect(after.completedAt).toBe(90_000);
    expect(after.completedAt).not.toBe(after.createdAt);
  });

  /**
   * The partial of a foreign interrupt has NO reader, so it goes.
   *
   * A `failed` record is settled: `findOpen` will not return it, so a re-POST mints a new id
   * and a new `.part`. The only resume caller left is `requeueInterrupted`, and it matches
   * solely on a record `load()` demoted — `code === 'cancelled'` plus the interrupted-by-restart
   * message. Nothing matches this record ever again, so keeping the bytes would hold cap space
   * until the TTL sweep for a file nobody can continue.
   */
  it('deletes the partial it leaves behind, since nothing can resume from it', async () => {
    const id = 'fail-2';
    await seed(id);
    const part = store.partPath(id);

    await run(id, {
      makeWindow: () => fakeWindow((self) => {
        const dl = new FakeItem({ received: HALF.length });
        currentSession.emit('will-download', {}, dl.item, self.webContents);
        // Chromium is the writer, and an interrupt leaves what it had written on disk.
        void writeFile(part, HALF).then(() => { dl.finish('interrupted'); });
      }).window,
    });

    expect(store.get(id)!.state).toBe('failed');
    expect(store.get(id)!.received).toBe(HALF.length);
    expect(await files(id)).toEqual([]);
  });

  /**
   * `failureOf` is the one place a thrown value becomes a `FailureCode`, and `ENOSPC` is the
   * only errno it treats specially — a full disk is a fault the caller can act on, and
   * reporting it as `network` would send them retrying against a host that is fine.
   *
   * Provoked here from the window factory, which is a real place it can come from: the window
   * is on a PERSISTENT partition, so creating it writes to disk.
   */
  it('reports a full disk as disk-full rather than as a network fault', async () => {
    const id = 'fail-3';
    await seed(id);
    clock = 4242;

    await run(id, {
      makeWindow: () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      },
    });

    const after = store.get(id)!;
    expect(after.state).toBe('failed');
    expect(after.error!.code).toBe('disk-full');
    expect(after.error!.message).toMatch(/no space left/i);
    expect(after.completedAt).toBe(4242);
  });
});

describe('resuming a partial through createInterruptedDownload', () => {
  const meta = {
    urlChain: ['http://x.test/payload.bin'],
    mimeType: 'application/octet-stream',
    eTag: 'W/"v1"',
    lastModified: '',
    startTimeSec: 1_700_000_000,
    totalBytes: BODY.length,
    receivedBytes: 0,
  };

  /** A record that survived a restart with a validator and half its bytes on disk. */
  const seedResumable = async (id: string): Promise<string> => {
    await seed(id, { resume: meta, received: HALF.length });
    const part = store.partPath(id);
    await writeFile(part, HALF);
    return part;
  };

  it('resumes from the surviving bytes, with no window, and finishes the file', async () => {
    const id = 'res-1';
    const part = await seedResumable(id);
    let windows = 0;

    // The whole correlation: the emission is synchronous INSIDE the call, so the one-shot
    // armed on the line above captures this call's own item and no other.
    const ses = new FakeSession((s, call) => {
      const dl = new FakeItem({
        savePath: call.path,
        received: BODY.length,
        totalBytes: BODY.length,
        // A resumed item is born interrupted and does nothing until `resume()`.
        onResume: (it) => {
          void appendFile(part, BODY.subarray(HALF.length)).then(() => { it.finish('completed'); });
        },
      });
      s.emit('will-download', {}, dl.item, null);
    });
    currentSession = ses;

    await run(id, {
      makeWindow: () => { windows += 1; throw new Error('a resume must not open a window'); },
    });

    // No window: `createInterruptedDownload` is a session API and would ignore one.
    expect(windows).toBe(0);
    // The args, as `planResume` computed them from the record and the bytes on disk.
    expect(ses.resumeCalls).toHaveLength(1);
    expect(ses.resumeCalls[0]).toMatchObject({
      path: part,
      offset: HALF.length,          // the file on disk, not the throttled counter
      length: BODY.length,
      eTag: 'W/"v1"',
      lastModified: '',
      mimeType: 'application/octet-stream',
      urlChain: meta.urlChain,
      startTime: 1_700_000_000,
    });
    // The one-shot is gone either way — it removes itself when it fires, and the `finally`
    // removes it when it does not. A leak here would let one resume eat another's event.
    expect(ses.listenerCount('will-download')).toBe(0);

    const after = store.get(id)!;
    expect(after.state).toBe('done');
    expect(after.size).toBe(BODY.length);
    // The proof it CONTINUED rather than started over: the finished file is the half that
    // survived plus the tail, hashing to the whole body.
    expect(after.sha256).toBe(SHA);
    expect(after.received).toBe(BODY.length);
    expect(await files(id)).toEqual([`${id}.bin`]);
    expect((await stat(store.filePath(id))).size).toBe(BODY.length);
  });

  /**
   * The tripwire. Two live records must never share a `path` — ours are `<id>.part` with UUID
   * ids, so it holds by construction — and the synchronous emission the correlation rests on is
   * undocumented. If either ever stopped holding, the item arriving here would be someone
   * else's, and adopting it would write their bytes into our file. So the save path is checked,
   * and a mismatch refuses the item rather than trusting it.
   */
  it('refuses an item whose save path is not ours, rather than writing its bytes', async () => {
    const id = 'res-2';
    const part = await seedResumable(id);
    let stray: FakeItem | null = null;

    const ses = new FakeSession((s) => {
      stray = new FakeItem({
        savePath: join(dir, 'somebody-else.part'),
        // A LIVE item, not an inert one: adopting it really would run to completion and settle
        // this record `done` over a file it never wrote. That is what the refusal prevents, and
        // it is what makes the assertions below fail on a value rather than on a timeout when
        // the tripwire is removed.
        onResume: (it) => { it.finish('completed'); },
      });
      s.emit('will-download', {}, stray.item, null);
    });
    currentSession = ses;

    await run(id, { makeWindow: () => { throw new Error('no window'); } });

    // Not adopted: never resumed, and never cancelled either — cancelling deletes a partial
    // that is not ours to delete.
    expect(stray!.resumed).toBe(0);
    expect(stray!.cancelled).toBe(0);
    // We hold no item, so nothing else could ever settle this record.
    const after = store.get(id)!;
    expect(after.state).toBe('failed');
    expect(after.error!.code).toBe('network');
    expect(after.error!.message).toMatch(/did not produce a download item/i);
    // OUR partial is untouched by the refusal — this settle is not the foreign-interrupt one.
    expect((await stat(part)).size).toBe(HALF.length);
  });

  /**
   * A `createInterruptedDownload` that emits nothing. Either the emission was not synchronous
   * after all or Chromium refused the arguments — and both mean the record would sit `running`
   * forever with no item to settle it, which `findOpen` would then fold every re-POST onto.
   */
  it('fails the record when the call produces no download item at all', async () => {
    const id = 'res-3';
    await seedResumable(id);
    clock = 7777;

    const ses = new FakeSession(); // records the call, emits nothing
    currentSession = ses;

    await run(id, { makeWindow: () => { throw new Error('no window'); } });

    expect(ses.resumeCalls).toHaveLength(1);
    // The leak-stopper ran: an armed one-shot left behind would fire on someone else's item.
    expect(ses.listenerCount('will-download')).toBe(0);

    const after = store.get(id)!;
    expect(after.state).toBe('failed');
    expect(after.error!.message).toMatch(/did not produce a download item/i);
    expect(after.completedAt).toBe(7777);
  });
});
