/**
 * Idle windows retained across ALL sessions, not per session.
 *
 * `/v1` derives the session name from the hostname, so without a global ceiling every
 * distinct host ever solved would leave one live Chromium renderer resident for the life of
 * the daemon. Four is enough that a small rotation of hosts still hits a warm partition,
 * and small enough that a scraper walking a thousand hosts does not accumulate a thousand
 * processes. Evicting a window costs only the challenge on that host's next visit: the
 * cookies live in the `persist:` partition on disk, not in the window.
 */
export const MAX_IDLE_WINDOWS = 4;

/**
 * How a pool makes and unmakes windows. Injected so the pool's policy — the idle cap, the
 * eviction order, the destroyed-window draining — is testable without an Electron runtime.
 * Production passes nothing and gets the real Chromium factory below.
 */
export interface BrowserPoolOptions {
  create: (sessionName: string) => Promise<Electron.BrowserWindow>;
  destroy: (win: Electron.BrowserWindow) => void;
  maxIdle: number;
}

/**
 * Imported lazily rather than at module scope: a static `import ... from 'electron'` makes
 * this file unloadable outside an Electron runtime, which would put the pool's policy beyond
 * the reach of a unit test.
 */
async function createElectronWindow(sessionName: string): Promise<Electron.BrowserWindow> {
  const { BrowserWindow, session } = await import('electron');
  const partition = `persist:${sessionName}`;
  session.fromPartition(partition);
  return new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
}

/**
 * Hidden BrowserWindows, one persistent partition per session name. The partition is what
 * carries a cleared host's cookies forward, so a second request to the same host normally
 * skips the challenge entirely.
 *
 * Windows are never given nodeIntegration: the renderer runs whatever the site serves.
 */
export class BrowserPool {
  private readonly free = new Map<string, Electron.BrowserWindow[]>();
  /** Every idle window, least-recently-released first. The eviction order. */
  private readonly idle: Electron.BrowserWindow[] = [];
  private readonly all = new Set<Electron.BrowserWindow>();
  /**
   * The session a window was created for. A WeakMap rather than recovering the name from the
   * window's storage path: path matching would confuse `vimm` with `vimm2`, and this is the
   * authoritative value anyway since we are the ones who chose it.
   */
  private readonly sessionOf = new WeakMap<Electron.BrowserWindow, string>();
  private inUse = 0;

  private readonly create: BrowserPoolOptions['create'];
  private readonly destroyWindow: BrowserPoolOptions['destroy'];
  private readonly maxIdle: number;

  constructor(private readonly maxPerSession = 1, opts: Partial<BrowserPoolOptions> = {}) {
    this.create = opts.create ?? createElectronWindow;
    this.destroyWindow = opts.destroy ?? ((win) => win.destroy());
    this.maxIdle = opts.maxIdle ?? MAX_IDLE_WINDOWS;
  }

  get busy(): number { return this.inUse; }
  get total(): number { return this.all.size; }
  /** Windows retained but not in use. Never exceeds the idle cap. */
  get idleCount(): number { return this.idle.length; }

  async acquire(sessionName: string): Promise<Electron.BrowserWindow> {
    const pool = this.free.get(sessionName) ?? [];

    let win = pool.pop();
    while (win && win.isDestroyed()) {
      this.unlistIdle(win);
      this.all.delete(win);
      win = pool.pop();
    }

    if (win) {
      // In use now, so no longer a candidate for idle eviction.
      this.unlistIdle(win);
    } else {
      win = await this.create(sessionName);
      this.all.add(win);
    }

    this.sessionOf.set(win, sessionName);
    // An empty list is not worth a map entry: `/v1` derives the session from the hostname, so
    // keeping one per name ever seen is the same unbounded growth in miniature.
    this.remember(sessionName, pool);
    this.inUse++;
    return win;
  }

  release(win: Electron.BrowserWindow): void {
    this.inUse = Math.max(0, this.inUse - 1);

    const name = this.sessionOf.get(win);
    if (win.isDestroyed() || name === undefined) {
      this.unlistIdle(win);
      this.all.delete(win);
      return;
    }

    const pool = this.free.get(name) ?? [];

    if (pool.length >= this.maxPerSession) {
      this.remember(name, pool);
      this.discard(win, name);
      return;
    }

    pool.push(win);
    this.remember(name, pool);
    this.idle.push(win);

    // Evict only after adding, and from the front, so the window just released is the last
    // thing considered rather than the first. A window in use is not in `idle` at all, so it
    // can never be the victim.
    while (this.idle.length > this.maxIdle) {
      const victim = this.idle[0]!;
      this.discard(victim, this.sessionOf.get(victim));
    }
  }

  /**
   * Tear down everything retained for one session name. The caller (`sessions.destroy`)
   * follows this by clearing the partition on disk; leaving a warm window behind would let
   * the next solve resume with the very `cf_clearance` the caller asked to be rid of.
   *
   * A window currently in use is not touched — it is mid-solve, and its owner releases it.
   */
  destroySession(name: string): void {
    for (const win of this.free.get(name) ?? []) this.discardWindow(win);
    this.free.delete(name);
  }

  destroy(): void {
    for (const w of this.all) if (!w.isDestroyed()) this.destroyWindow(w);
    this.all.clear();
    this.free.clear();
    this.idle.length = 0;
    this.inUse = 0;
  }

  /** Drop a window from every record and destroy it. */
  private discard(win: Electron.BrowserWindow, name: string | undefined): void {
    if (name !== undefined) {
      const pool = this.free.get(name);
      if (pool) {
        const at = pool.indexOf(win);
        if (at >= 0) pool.splice(at, 1);
        this.remember(name, pool);
      }
    }
    this.discardWindow(win);
  }

  /** Keep a session's free list only while it holds something. */
  private remember(name: string, pool: Electron.BrowserWindow[]): void {
    if (pool.length > 0) this.free.set(name, pool);
    else this.free.delete(name);
  }

  private discardWindow(win: Electron.BrowserWindow): void {
    this.unlistIdle(win);
    this.all.delete(win);
    if (!win.isDestroyed()) this.destroyWindow(win);
  }

  /** Remove from the LRU order only; the session's free list is handled by the caller. */
  private unlistIdle(win: Electron.BrowserWindow): void {
    const at = this.idle.indexOf(win);
    if (at >= 0) this.idle.splice(at, 1);
  }
}
