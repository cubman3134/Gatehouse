import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { BrowserWindow, DownloadItem, Session, WebContents } from 'electron';
import { DownloadStore } from '../../src/downloads/store.js';
import { browserDownload, type BrowserDownloadDeps, type RecipeIpc } from '../../src/downloads/browser.js';
import { STEP_CHANNEL, RESULT_CHANNEL, type Recipe } from '../../src/downloads/recipe.js';
import { recipePreloadPath } from '../../src/preload/path.js';

/**
 * The recipe wiring, driven against the REAL preload — loaded from its own file and executed —
 * with only Electron replaced.
 *
 * Every failure this feature has is a silent one. A channel name that drifts, an argument order
 * that does not match the handler, a `send` that never settles, a preload that does not load:
 * each produces the same symptom, which is that the download hangs forever holding a slot, and
 * a message about the page rather than about the wiring. `test/unit/preload.test.ts` pins the
 * two channel NAMES by reading them as text. This file pins the message SHAPE, by putting a
 * real step through the real handler and back:
 *
 *   main → `wc.send(STEP_CHANNEL, seq, step, deadline)`
 *        → the preload's `ipcRenderer.on(STEP_CHANNEL, (_e, seq, step, deadline) => …)`
 *        → `ipcRenderer.send(RESULT_CHANNEL, seq, result)`
 *        → main's one-shot, filtered on sender id and seq.
 *
 * Swap any two of those arguments on either side and the round trip below stops working. The
 * integration suite would catch it too, eventually, as a two-second timeout with a message
 * blaming the site's markup — which is exactly the diagnosis this test exists to prevent.
 *
 * The preload cannot simply be `require`d: it calls `require('electron')` and touches
 * `document` at load. So it runs in a `vm` context holding both, which is also what makes the
 * DOM half — the polling, the text filter, the attribute read — reachable from a unit test at
 * all.
 */

const PRELOAD = recipePreloadPath();

/** An element that answers to exactly one selector string. Enough for the preload's needs. */
interface FakeEl {
  sel: string;
  textContent: string;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  click?: () => void;
}

const el = (sel: string, opts: { text?: string; attrs?: Record<string, string>; onClick?: () => void; clickable?: boolean } = {}): FakeEl => ({
  sel,
  textContent: opts.text ?? '',
  attrs: opts.attrs ?? {},
  getAttribute(name: string) { return Object.hasOwn(this.attrs, name) ? this.attrs[name]! : null; },
  ...(opts.clickable === false ? {} : { click: opts.onClick ?? ((): void => {}) }),
});

class FakeDoc {
  els: FakeEl[] = [];
  querySelectorAll(sel: unknown): FakeEl[] {
    // A real `querySelectorAll` takes a string. Being strict here is what turns an
    // argument-order drift into a named failure instead of a silent "matched nothing".
    if (typeof sel !== 'string') throw new Error(`selector must be a string, got ${typeof sel}`);
    return this.els.filter((e) => e.sel === sel);
  }
}

/** The renderer half: the real preload, running in a vm over a fake `ipcRenderer` and DOM. */
interface Renderer {
  doc: FakeDoc;
  /** Deliver an outbound step exactly as `ipcMain` → `ipcRenderer` would. */
  deliver: (...args: unknown[]) => void;
  /** Everything the preload sent back, in order, with its channel. */
  replies: Array<{ channel: string; args: unknown[] }>;
  /** Set to swallow replies, so the main side has to survive a page that never answers. */
  mute: boolean;
}

function loadPreload(onReply: (channel: string, args: unknown[]) => void): Renderer {
  const doc = new FakeDoc();
  const inbound = new EventEmitter();
  const out: Renderer = {
    doc,
    deliver: (...args: unknown[]) => { inbound.emit(STEP_CHANNEL, {}, ...args); },
    replies: [],
    mute: false,
  };
  const ipcRenderer = {
    on: (channel: string, cb: (...args: unknown[]) => void) => { inbound.on(channel, cb); },
    send: (channel: string, ...args: unknown[]) => {
      out.replies.push({ channel, args });
      if (!out.mute) onReply(channel, args);
    },
  };
  const context = createContext({
    require: (m: string) => {
      if (m !== 'electron') throw new Error(`the preload must not require ${m}`);
      return { ipcRenderer };
    },
    document: doc,
    setTimeout,
    clearTimeout,
    console,
    module: { exports: {} },
    exports: {},
  });
  runInContext(readFileSync(PRELOAD, 'utf8'), context, { filename: PRELOAD });
  return out;
}

/** `ipcMain`, structurally. An EventEmitter is exactly the contract `RecipeIpc` names. */
const fakeIpc = (): RecipeIpc & EventEmitter => new EventEmitter() as RecipeIpc & EventEmitter;

class FakeItem extends EventEmitter {
  savePath = '';
  cancelled = 0;
  setSavePath(p: string): void { this.savePath = p; }
  getSavePath(): string { return this.savePath; }
  getReceivedBytes(): number { return 0; }
  getFilename(): string { return 'derived.bin'; }
  getMimeType(): string { return 'application/octet-stream'; }
  getTotalBytes(): number { return 0; }
  getURLChain(): string[] { return ['http://host.test/file.bin']; }
  getETag(): string { return ''; }
  getLastModifiedTime(): string { return ''; }
  getStartTime(): number { return 1_700_000_000; }
  /**
   * Chromium DELETES the file of an item it cancelled — including a paused one — and the fake
   * does it too, because that is the behaviour one of the tests below is about. An engine that
   * pointed a doomed item at the ADOPTED item's `.part` would destroy the download it is
   * keeping, and a fake that merely counted cancels could not tell.
   */
  cancel(): void {
    this.cancelled += 1;
    if (this.savePath) rmSync(this.savePath, { force: true });
  }
  resume(): void {}
  /** What Chromium's own `done` is: the file is closed by the time this fires. */
  finish(state: string): void { this.emit('done', {}, state); }
  get item(): DownloadItem { return this as unknown as DownloadItem; }
}

class FakeSession extends EventEmitter {
  createInterruptedDownload(): void { /* the resume path is covered in browser.test.ts */ }
  get session(): Session { return this as unknown as Session; }
}

let dir: string;
let store: DownloadStore;
let ses: FakeSession;
let ipc: RecipeIpc & EventEmitter;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-bridge-'));
  ses = new FakeSession();
  ipc = fakeIpc();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const RECIPE: Recipe = {
  startUrl: 'http://host.test/page',
  steps: [
    { op: 'click', selector: 'button', text: 'Download' },
    { op: 'waitFor', selector: 'a#link' },
    { op: 'readAttribute', selector: 'a#link', attribute: 'href' },
  ],
};

interface Rig {
  /** Everything `downloadURL` was asked to fetch, in order. */
  asked: string[];
  renderer: Renderer;
  windows: number;
  /** The page's own navigation starting a download mid-recipe. */
  startItemFromPage: () => FakeItem;
}

/**
 * Wire main and renderer together over the fakes and run one download to completion.
 *
 * `wc.send` forwards into the vm; the preload's reply comes back on `ipcMain` carrying this
 * window's id as its sender. That is the whole bridge, minus Chromium.
 */
async function runRecipeDownload(
  id: string,
  opts: {
    seedDoc?: (r: Renderer, rig: Rig) => void;
    stepMs?: number;
    totalMs?: number;
    preload?: string;
    /** What the fake browser does when finally asked for the derived URL. */
    onDownload?: (rig: Rig, url: string) => void;
    mutePage?: boolean;
    /** Fire `preload-error` as the first step goes out, the way a broken preload would have. */
    breakPreloadOnFirstStep?: boolean;
    signal?: AbortSignal;
    /** This window's webContents id — the value the main side filters replies on. */
    wcId?: number;
    /** Its own downloads directory, so two concurrent jobs do not share a manifest. */
    dir?: string;
    /**
     * What the window's own navigation does. The default resolves, as a load that committed.
     * A rejection is a main document that failed — `ERR_NAME_NOT_RESOLVED` on a host that is
     * not there, `ERR_ABORTED` on a page that navigated away from itself deliberately.
     */
    loadURL?: (rig: Rig) => Promise<void>;
  } = {},
): Promise<{ rec: ReturnType<DownloadStore['get']>; rig: Rig; elapsed: number; store: DownloadStore }> {
  const own = new DownloadStore({ dir: opts.dir ?? dir, now: () => Date.now(), idgen: () => id, ttlMs: 600_000, maxBytes: 1e9 });
  store = own;
  await own.create({ url: RECIPE.startUrl, session: 'host.test', referer: null, viaRecipe: true });

  const wcId = opts.wcId ?? 77;
  const rig: Rig = {
    asked: [],
    renderer: null as unknown as Renderer,
    windows: 0,
    startItemFromPage: () => new FakeItem(),
  };

  rig.renderer = loadPreload((channel, args) => {
    // `(seq, result)` inbound, carrying the SENDER — both are what the main side filters on.
    ipc.emit(channel, { sender: { id: wcId } }, ...args);
  });
  rig.renderer.mute = opts.mutePage ?? false;

  const preloadEvents = new EventEmitter();
  let destroyed = false;
  let stepsSent = 0;
  const webContents = {
    id: wcId,
    loadURL: (): Promise<void> => (opts.loadURL ? opts.loadURL(rig) : Promise.resolve()),
    getURL: () => RECIPE.startUrl,
    send: (channel: string, ...args: unknown[]) => {
      if (channel !== STEP_CHANNEL) throw new Error(`the main side sent on ${channel}`);
      stepsSent += 1;
      if (opts.breakPreloadOnFirstStep && stepsSent === 1) {
        // Electron delivers this asynchronously, after the window is up and the page is live.
        setTimeout(() => {
          preloadEvents.emit('preload-error', {}, PRELOAD, new Error('Cannot use import statement outside a module'));
        }, 20).unref?.();
      }
      rig.renderer.deliver(...args);
    },
    downloadURL: (url: string) => {
      rig.asked.push(url);
      opts.onDownload?.(rig, url);
    },
    on: (event: string, cb: (...args: unknown[]) => void) => { preloadEvents.on(event, cb); },
    removeListener: (event: string, cb: (...args: unknown[]) => void) => { preloadEvents.removeListener(event, cb); },
  } as unknown as WebContents;

  rig.startItemFromPage = (): FakeItem => {
    const dl = new FakeItem();
    // The `will-download` correlation compares against this exact webContents identity.
    ses.emit('will-download', {}, dl.item, webContents);
    return dl;
  };
  opts.seedDoc?.(rig.renderer, rig);

  const win = {
    webContents,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
  } as unknown as BrowserWindow;

  const deps: BrowserDownloadDeps = {
    store: own,
    partitionFor: () => ses.session,
    makeWindow: () => { rig.windows += 1; return win; },
    noStartMs: 60_000,
    stallMs: 120_000,
    recipe: {
      recipe: RECIPE,
      stepMs: opts.stepMs ?? 2_000,
      totalMs: opts.totalMs ?? 10_000,
      preload: opts.preload ?? PRELOAD,
      ipc,
    },
  };

  const started = Date.now();
  await browserDownload(id, deps, opts.signal ?? new AbortController().signal);
  return { rec: own.get(id), rig, elapsed: Date.now() - started, store: own };
}

/** The page the measured flow describes: a button that reveals a link a moment later. */
const revealing = (href: string, afterMs = 50) => (r: Renderer): void => {
  r.doc.els.push(el('button', {
    text: 'Download',
    onClick: () => {
      setTimeout(() => { r.doc.els.push(el('a#link', { text: 'get it', attrs: { href } })); }, afterMs).unref?.();
    },
  }));
};

describe('the recipe bridge, main to preload and back', () => {
  /**
   * The round trip, through the real preload. It proves the two channel names AND the two
   * argument orders at once — and the DOM half besides: the click, the text filter, the poll
   * that waits for an element that is not there yet, and the attribute read.
   */
  it('clicks, waits, reads the attribute and asks for the derived URL', async () => {
    const { rec, rig } = await runRecipeDownload('bridge-1', {
      seedDoc: revealing('http://host.test/file.bin?token=abc'),
      onDownload: (r) => {
        const dl = r.startItemFromPage();
        dl.finish('interrupted'); // settling is browser.test.ts's business, not this file's
      },
    });

    expect(rig.asked).toEqual(['http://host.test/file.bin?token=abc']);
    // Three steps, three replies, in order, on the result channel.
    expect(rig.renderer.replies.map((r) => r.channel)).toEqual([RESULT_CHANNEL, RESULT_CHANNEL, RESULT_CHANNEL]);
    expect(rig.renderer.replies.map((r) => r.args[0])).toEqual([1, 2, 3]);
    expect(rig.renderer.replies[2]!.args[1]).toEqual({ ok: true, value: 'http://host.test/file.bin?token=abc' });
    expect(rec!.state).toBe('failed'); // the fake item interrupted; the recipe itself succeeded
    expect(rec!.error!.code).toBe('network');
  });

  /** A relative href is what a real page usually holds, and a browser resolves it. */
  it('resolves a relative href against the page it was read from', async () => {
    const { rig } = await runRecipeDownload('bridge-2', {
      seedDoc: revealing('/downloads/thing.bin'),
      onDownload: (r) => { r.startItemFromPage().finish('interrupted'); },
    });
    expect(rig.asked).toEqual(['http://host.test/downloads/thing.bin']);
  });

  /**
   * THE gate. A derived URL is site-controlled input that no caller and no validator has seen,
   * and `file:` parses perfectly. `runRecipe` hands it back unvalidated on purpose.
   */
  it('refuses a derived URL the scheme gate rejects, and fetches nothing', async () => {
    const { rec, rig } = await runRecipeDownload('bridge-3', {
      seedDoc: revealing('file:///C:/Windows/win.ini'),
    });
    expect(rig.asked).toEqual([]);
    expect(rec!.state).toBe('failed');
    expect(rec!.error!.code).toBe('recipe-failed');
    expect(rec!.error!.message).toMatch(/file:/);
    expect(rec!.error!.message).toMatch(/scheme/i);
  });

  /** Resolution cannot launder a scheme: an absolute hostile href stays absolute and hostile. */
  it('does not let base resolution turn a hostile scheme into an http one', async () => {
    for (const href of ['file:///C:/x', 'javascript:alert(1)', 'data:text/plain,hi']) {
      const { rec, rig } = await runRecipeDownload(`bridge-scheme-${href.length}`, { seedDoc: revealing(href) });
      expect(rig.asked, href).toEqual([]);
      expect(rec!.error!.code, href).toBe('recipe-failed');
    }
  });

  it('names the step index and the selector when a step matches nothing', async () => {
    const { rec, elapsed } = await runRecipeDownload('bridge-4', {
      // The button is there; the link never arrives.
      seedDoc: (r) => { r.doc.els.push(el('button', { text: 'Download' })); },
      stepMs: 400,
    });
    expect(rec!.error!.code).toBe('recipe-failed');
    expect(rec!.error!.message).toMatch(/step 1 \(waitFor a#link\)/);
    expect(rec!.error!.message).toMatch(/matched nothing/);
    // Bounded by the STEP budget, not by the total: one step's worth plus the bridge grace.
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe('a page bridge that does not answer', () => {
  /**
   * The obligation `runRecipe` documents and cannot discharge: it holds no timer that could
   * cancel a promise it did not create, so a `send` that never settles hangs the recipe past
   * every deadline in that module, FOREVER, holding a download slot. A preload that fails to
   * load produces exactly this. The race below is the only bound there is.
   */
  it('fails the step on the deadline rather than waiting forever', async () => {
    const { rec, elapsed } = await runRecipeDownload('silent-1', {
      seedDoc: revealing('http://host.test/file.bin'),
      mutePage: true, // the page receives every step and answers none
      stepMs: 300,
      totalMs: 10_000,
    });
    expect(rec!.state).toBe('failed');
    expect(rec!.error!.code).toBe('recipe-failed');
    expect(rec!.error!.message).toMatch(/step 0/);
    expect(rec!.error!.message).toMatch(/no answer from the page bridge/);
    // One step deadline plus the grace — not three, and emphatically not never.
    expect(elapsed).toBeLessThan(3_000);
  });

  /**
   * The loser of that race is DROPPED, not thrown and not applied.
   *
   * A reply arriving after its step timed out must not be handed to whatever step is running
   * now — the sequence filter is what stops "step 0 answered late" being read as "step 1
   * succeeded" — and it must not reject into a `void`ed job path either.
   */
  it('drops a reply that arrives after the step already timed out', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { rec } = await runRecipeDownload('silent-2', {
        seedDoc: revealing('http://host.test/file.bin'),
        mutePage: true,
        stepMs: 300,
      });
      expect(rec!.error!.code).toBe('recipe-failed');

      // The page finally answers step 0, long after the recipe gave up on it. Nothing is
      // listening, nothing throws, and the settled record is not disturbed.
      const before = { ...rec!.error };
      ipc.emit(RESULT_CHANNEL, { sender: { id: 77 } }, 1, { ok: true, value: 'http://host.test/late.bin' });
      await new Promise((r) => setTimeout(r, 50));
      expect(store.get('silent-2')!.error).toEqual(before);
      // And nobody is left listening on the channel for it.
      expect(ipc.listenerCount(RESULT_CHANNEL)).toBe(0);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  /**
   * A preload that exists but cannot be loaded fires `preload-error` and then nothing at all:
   * the window loads, the page renders, the renderer stays alive, and every step hangs. The
   * listener turns that into a wiring message on the spot instead of one step deadline later.
   */
  it('abandons the step in flight the moment preload-error fires', async () => {
    const { rec, elapsed } = await runRecipeDownload('silent-3', {
      mutePage: true,
      breakPreloadOnFirstStep: true,
      stepMs: 30_000, // the deadline must not be what ends this
      totalMs: 60_000,
      seedDoc: (r) => { r.doc.els.push(el('button', { text: 'Download' })); },
    });
    expect(rec!.error!.code).toBe('recipe-failed');
    expect(rec!.error!.message).toMatch(/bridge failed to load/);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});

describe('two recipe windows on one ipcMain', () => {
  /** The URL only B's page can produce. If it ever comes out of A, a reply crossed windows. */
  const B_URL = 'http://host.test/b-only.bin';

  /**
   * `ipcMain` is process-wide: every concurrent recipe window answers on the SAME result
   * channel, and the only thing that tells our page's reply from a sibling's is the sender id
   * the main side filters on. Every other test in this file runs ONE window against a fresh
   * emitter, where deleting that filter changes nothing at all.
   *
   * So: two jobs, at once, on one emitter. A's page receives every step and answers none. B's
   * answers normally and derives a URL only B's document contains. With the filter, A hears
   * none of B's traffic and dies on its own step-0 deadline having fetched nothing. Without it,
   * A takes B's replies for its own and downloads B's file — a job completing on another job's
   * bytes, which reaches the caller as a plausible-looking download of the wrong thing and
   * appears in no log as anything but success.
   *
   * **B is started second, deliberately.** A step listens for ONE sequence number and A's never
   * advances past 1, so a reply it can mistake for its own has to arrive while it is parked on
   * that step. Racing both jobs off the same line makes that a coin flip — measured, B's first
   * reply beat A's first listener about half the time, and a filterless build passed. So A is
   * given a head start, and `finished` below asserts the precondition rather than assuming it:
   * B's whole exchange has to complete inside A's wait, or this proves nothing.
   */
  it("ignores a reply carrying the other window's sender id", async () => {
    const aDir = join(dir, 'a');
    const bDir = join(dir, 'b');
    await mkdir(aDir);
    await mkdir(bDir);

    const finished: string[] = [];
    const a = runRecipeDownload('crosstalk-a', {
      dir: aDir,
      wcId: 77,
      mutePage: true, // A's page is handed every step and answers none of them
      stepMs: 2_000, // long enough to hold A on step 0 for the whole of B's run
      totalMs: 20_000,
      seedDoc: (r) => { r.doc.els.push(el('button', { text: 'Download' })); },
      // Only ever reached if A acted on a reply that was not its own. Without it that path
      // would hang on the no-start window and read as a timeout instead of as the assertion
      // below.
      onDownload: (r) => { r.startItemFromPage().finish('interrupted'); },
    }).then((r) => { finished.push('a'); return r; });

    // A is parked on step 0 by now: everything before its first `send` is synchronous or a
    // microtask, and the only timer in play is its own 2s step deadline.
    await new Promise((r) => setTimeout(r, 150));

    const b = runRecipeDownload('crosstalk-b', {
      dir: bDir,
      wcId: 88,
      seedDoc: revealing(B_URL),
      onDownload: (r) => { r.startItemFromPage().finish('interrupted'); },
    }).then((r) => { finished.push('b'); return r; });

    const [ra, rb] = await Promise.all([a, b]);

    // The precondition: B ran its whole exchange, on the shared emitter, while A sat waiting
    // for an answer. Without this the test could pass with no cross-talk to ignore at all.
    expect(finished, 'B did not answer while A was still waiting on a step').toEqual(['b', 'a']);
    expect(rb.rig.renderer.replies.map((r) => r.args[0])).toEqual([1, 2, 3]);
    expect(rb.rig.asked).toEqual([B_URL]);

    // And A heard none of it: no fetch, and the failure is still its OWN silent page.
    expect(ra.rig.asked, "a job fetched a URL only the other window's page produced").toEqual([]);
    expect(ra.rec!.state).toBe('failed');
    expect(ra.rec!.error!.code).toBe('recipe-failed');
    expect(ra.rec!.error!.message).toMatch(/step 0/);
    expect(ra.rec!.error!.message).toMatch(/no answer from the page bridge/);
  }, 20_000);
});

describe('a recipe download that cannot be wired', () => {
  /**
   * Measured: with a missing preload the window loads, the page renders, the renderer stays
   * alive and every step hangs. `recipePreloadPath()` does no existence check, so this one is
   * made before a window is opened at all — a mis-wired app must not present as a dead site.
   */
  it('refuses before opening a window when the preload file is not there', async () => {
    const { rec, rig } = await runRecipeDownload('missing-1', {
      preload: join(dir, 'no-such-preload.cjs'),
      seedDoc: revealing('http://host.test/file.bin'),
    });
    expect(rec!.state).toBe('failed');
    expect(rec!.error!.code).toBe('recipe-failed');
    expect(rec!.error!.message).toMatch(/preload is missing/);
    expect(rec!.error!.message).toMatch(/mis-wired/);
    expect(rig.windows).toBe(0);
    expect(rig.asked).toEqual([]);
  });
});

describe('a download that starts while the recipe is still running', () => {
  /**
   * The second legitimate ending. A `click` is free to start the download itself, and when it
   * does, that item IS the result: the remaining steps are abandoned rather than run to their
   * deadlines, and no `readAttribute` needs to have produced anything.
   */
  it('takes the item as the result and stops stepping', async () => {
    const { rec, rig, elapsed } = await runRecipeDownload('direct-1', {
      stepMs: 30_000, // if the remaining steps were run, this test would take half a minute
      totalMs: 60_000,
      seedDoc: (r, rig) => {
        r.doc.els.push(el('button', {
          text: 'Download',
          onClick: () => {
            setTimeout(() => {
              const dl = rig.startItemFromPage();
              setTimeout(() => { dl.finish('interrupted'); }, 10).unref?.();
            }, 20).unref?.();
          },
        }));
      },
    });

    expect(rig.asked, 'a derived URL was fetched even though an item had already arrived').toEqual([]);
    // It settled on the ITEM, not on a recipe failure.
    expect(rec!.error!.code).toBe('network');
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);
});

describe('a recipe record picked back up after a restart', () => {
  /**
   * Recipes are memory-only, so a restart has no way to re-derive the URL. The record's `url`
   * is the PAGE — "restarting" it would download HTML and settle `done` holding it, which is a
   * silent wrong answer. `viaRecipe` is the one bit that survives to make it a loud one.
   */
  it('refuses to restart a recipe download without its recipe', async () => {
    store = new DownloadStore({ dir, now: () => Date.now(), idgen: () => 'restart-1', ttlMs: 600_000, maxBytes: 1e9 });
    await store.create({ url: RECIPE.startUrl, session: 'host.test', referer: null, viaRecipe: true });

    let windows = 0;
    await browserDownload('restart-1', {
      store,
      partitionFor: () => ses.session,
      makeWindow: () => { windows += 1; return null as unknown as BrowserWindow; },
      noStartMs: 60_000,
      stallMs: 120_000,
    }, new AbortController().signal);

    const rec = store.get('restart-1')!;
    expect(rec.state).toBe('failed');
    expect(rec.error!.code).toBe('recipe-failed');
    expect(rec.error!.message).toMatch(/not persisted across a restart/);
    expect(windows, 'it opened a window to download the page it started from').toBe(0);
  });

  it('leaves an ordinary download alone', async () => {
    store = new DownloadStore({ dir, now: () => Date.now(), idgen: () => 'restart-2', ttlMs: 600_000, maxBytes: 1e9 });
    await store.create({ url: 'http://host.test/file.bin', session: 'host.test', referer: null });

    let asked = '';
    const wc = {
      id: 9,
      downloadURL: (url: string) => {
        asked = url;
        const dl = new FakeItem();
        ses.emit('will-download', {}, dl.item, wc);
        dl.finish('interrupted');
      },
    } as unknown as WebContents;
    await browserDownload('restart-2', {
      store,
      partitionFor: () => ses.session,
      makeWindow: () => ({ webContents: wc, isDestroyed: () => false, destroy: () => {} }) as unknown as BrowserWindow,
      noStartMs: 60_000,
      stallMs: 120_000,
    }, new AbortController().signal);

    expect(asked).toBe('http://host.test/file.bin');
    expect(store.get('restart-2')!.error!.code).toBe('network');
  });
});

describe('a page that starts more than one download', () => {
  const BODY = Buffer.from('the bytes of the download we are actually keeping');
  const SHA = createHash('sha256').update(BODY).digest('hex');

  /**
   * **The fatal one, in miniature.**
   *
   * `will-download` fires on the SESSION, and a page may start as many downloads as it likes:
   * two iframes, a handler bound twice, a script that loops `location.href`. The handler used
   * to remove itself as soon as it adopted an item, so every later item from that same window
   * reached the session unclaimed — a sibling job's handler rejects it on `webContents`, so
   * NOTHING calls `setSavePath`, and the item becomes Chromium's to dispose of. Measured against
   * the real app on Electron 43.4.1: the whole file goes into the USER'S Downloads folder under
   * a UUID `.tmp` name, silently, outside the store and outside retention. The documented
   * behaviour elsewhere is the native modal Save As dialog, which on a hidden window in a daemon
   * never resolves at all. Neither is survivable, and one rule designs out both.
   *
   * So the listener stays attached for the window's life and claims every item. The first is
   * the job; the rest get a save path of their own and are cancelled.
   *
   * `savePath` is the assertion that matters, twice over:
   *
   * - it must not be EMPTY — an item with no save path is the dialog, and it is what the old
   *   code left behind;
   * - it must not be `<id>.part` — Chromium deletes the file of an item it cancelled, and that
   *   file is the adopted item's live download. `FakeItem.cancel` really unlinks, so an engine
   *   that pointed the second item at our partial would take the bytes with it and the
   *   completion below could not happen.
   */
  it('keeps the first item and discards the second onto a path of its own', async () => {
    const id = 'twoitems-1';
    const part = join(dir, `${id}.part`);
    let first: FakeItem | null = null;
    let second: FakeItem | null = null;

    const { rec, rig, store: own } = await runRecipeDownload(id, {
      stepMs: 30_000, // if the steps ran on, this test would take half a minute
      totalMs: 60_000,
      seedDoc: (r, rig) => {
        r.doc.els.push(el('button', {
          text: 'Download',
          onClick: () => {
            setTimeout(() => {
              // One item, adopted, with Chromium writing into the save path it was given.
              first = rig.startItemFromPage();
              writeFileSync(part, BODY);
              // And a second one from the same window, moments later.
              second = rig.startItemFromPage();
              // Only then does the kept download finish, so the discard happened while our
              // partial was on disk with bytes in it.
              setTimeout(() => { first!.finish('completed'); }, 10).unref?.();
            }, 20).unref?.();
          },
        }));
      },
    });

    // The engine's own idea of the path, so this test cannot pass by asserting the wrong file.
    expect(own.partPath(id)).toBe(part);

    expect(first!.savePath).toBe(part);
    expect(first!.cancelled, 'the adopted item was cancelled').toBe(0);

    // Claimed: it was given a save path, which is the whole difference between a download and
    // a modal dialog on a window nobody can see.
    expect(second!.savePath, 'the second item reached the session unclaimed').not.toBe('');
    // But NOT ours, because cancelling deletes it.
    expect(second!.savePath, 'the second item was pointed at the adopted item\u2019s live file')
      .not.toBe(part);
    expect(second!.cancelled, 'the second item was left running').toBe(1);

    // The kept download completed on its own bytes, which is the proof the discard did not
    // take them: `done` here means the engine found, hashed and renamed the file.
    expect(rec!.state).toBe('done');
    expect(rec!.sha256).toBe(SHA);
    expect(rec!.size).toBe(BODY.length);
    expect(rig.asked, 'a URL was fetched even though an item had already arrived').toEqual([]);

    // One file in the directory and it is the finished one: the throwaway path was cleaned up
    // with the item it belonged to.
    expect((await readdir(dir)).filter((f) => f.startsWith(id)).sort()).toEqual([`${id}.bin`]);
  }, 20_000);
});

describe('a page whose main document fails after the download began', () => {
  const BODY = Buffer.from('bytes that arrived before the document gave up');
  const SHA = createHash('sha256').update(BODY).digest('hex');

  /**
   * A download can be adopted DURING the load — the `duringLoad` fixture in the integration
   * suite is exactly that — and a page is free to fail its own main document afterwards, by
   * navigating away from itself or by simply being served badly. `loadURL` then rejects with
   * the item already ours and its bytes already arriving.
   *
   * Reporting that as `recipe-failed` would be two wrongs at once: the verdict says the site's
   * markup broke when in truth the file is on its way, and the item's `done` still renames the
   * completed file into place — against a settled, failed record, where nothing will ever read
   * it and only the retention sweep will remove it.
   *
   * So the adopted item is checked FIRST here, exactly as it is after the steps.
   */
  it('completes on the item rather than blaming the recipe', async () => {
    const id = 'loadfail-1';
    const part = join(dir, `${id}.part`);

    const { rec, rig } = await runRecipeDownload(id, {
      // A download that begins as part of the document's own load, and a document that then
      // fails. Chromium rejects `loadURL` for both reasons; the item is unaffected by either.
      loadURL: async (rig) => {
        const dl = rig.startItemFromPage();
        writeFileSync(part, BODY);
        setTimeout(() => { dl.finish('completed'); }, 20).unref?.();
        throw new Error('ERR_ABORTED (-3) loading \u2018http://host.test/page\u2019');
      },
      seedDoc: revealing('http://host.test/file.bin'),
    });

    expect(rec!.error, 'the record was failed while its bytes were still arriving').toBeUndefined();
    expect(rec!.state).toBe('done');
    expect(rec!.sha256).toBe(SHA);
    // No step ever ran and no URL was derived: the item was the whole job.
    expect(rig.asked).toEqual([]);
    expect(rig.renderer.replies).toEqual([]);
    // And the finished file is the record's, not an orphan beside a failed one.
    expect((await readdir(dir)).filter((f) => f.startsWith(id)).sort()).toEqual([`${id}.bin`]);
  }, 20_000);
});

describe('a recipe that derives an enormous value', () => {
  /**
   * An `href` has no length limit — a `data:` URI holding an image is ordinary markup — and
   * every rejection on this path QUOTES what it refused. That message is written into the
   * record, into the manifest that is rewritten on every progress tick, and served back out of
   * `/gh/jobs/:id`. So the size is checked before anything parses or echoes the value.
   */
  it('refuses it by length, without quoting it into the record', async () => {
    // Unparseable as well as enormous — an unterminated IPv6 host throws out of `new URL`
    // with or without a base — because that is the path that used to embed it: the value
    // reaches `validateTarget`, fails to parse, and the rejection quotes what it read.
    const huge = `http://[${'a'.repeat(9_000)}`;
    const { rec, rig } = await runRecipeDownload('huge-1', { seedDoc: revealing(huge) });

    expect(rec!.state).toBe('failed');
    expect(rec!.error!.code).toBe('recipe-failed');
    expect(rec!.error!.message).toMatch(/9008 characters/);
    // The value itself is nowhere in the record, at any length.
    expect(rec!.error!.message).not.toContain('aaaaaaaaaa');
    expect(rec!.error!.message.length).toBeLessThan(300);
    expect(rig.asked).toEqual([]);
  });
});
