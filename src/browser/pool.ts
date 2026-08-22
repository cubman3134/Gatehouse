import { BrowserWindow, session as electronSession } from 'electron';

/**
 * Hidden BrowserWindows, one persistent partition per session name. The partition is what
 * carries a cleared host's cookies forward, so a second request to the same host normally
 * skips the challenge entirely.
 *
 * Windows are never given nodeIntegration: the renderer runs whatever the site serves.
 */
export class BrowserPool {
  private readonly free = new Map<string, Electron.BrowserWindow[]>();
  private readonly all = new Set<Electron.BrowserWindow>();
  /**
   * The session a window was created for. A WeakMap rather than recovering the name from the
   * window's storage path: path matching would confuse `vimm` with `vimm2`, and this is the
   * authoritative value anyway since we are the ones who chose it.
   */
  private readonly sessionOf = new WeakMap<Electron.BrowserWindow, string>();
  private inUse = 0;

  constructor(private readonly maxPerSession = 1) {}

  get busy(): number { return this.inUse; }
  get total(): number { return this.all.size; }

  async acquire(sessionName: string): Promise<Electron.BrowserWindow> {
    const pool = this.free.get(sessionName) ?? [];

    let win = pool.pop();
    while (win && win.isDestroyed()) {
      this.all.delete(win);
      win = pool.pop();
    }

    if (!win) {
      const partition = `persist:${sessionName}`;
      electronSession.fromPartition(partition);
      win = new BrowserWindow({
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
      this.all.add(win);
    }

    this.sessionOf.set(win, sessionName);
    this.free.set(sessionName, pool);
    this.inUse++;
    return win;
  }

  release(win: Electron.BrowserWindow): void {
    this.inUse = Math.max(0, this.inUse - 1);

    const name = this.sessionOf.get(win);
    if (win.isDestroyed() || name === undefined) { this.all.delete(win); return; }

    const pool = this.free.get(name) ?? [];
    if (pool.length < this.maxPerSession) pool.push(win);
    else { this.all.delete(win); win.destroy(); }
    this.free.set(name, pool);
  }

  destroy(): void {
    for (const w of this.all) if (!w.isDestroyed()) w.destroy();
    this.all.clear();
    this.free.clear();
    this.inUse = 0;
  }
}
