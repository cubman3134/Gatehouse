import { describe, it, expect } from 'vitest';
import { BrowserPool, MAX_IDLE_WINDOWS } from '../../src/browser/pool.js';

/**
 * A stand-in for a hidden BrowserWindow. The pool touches exactly two members of one —
 * `isDestroyed()` and `destroy()` — so the policy under test (the idle cap, the eviction
 * order, the destroyed-window draining) needs no Electron runtime behind it.
 */
interface FakeWindow {
  name: string;
  destroyed: boolean;
  isDestroyed(): boolean;
  destroy(): void;
}

function harness() {
  const created: FakeWindow[] = [];
  const destroyed: string[] = [];

  const make = (name: string, tag = ''): FakeWindow => {
    const win: FakeWindow = {
      name: tag || `${name}#${created.length + 1}`,
      destroyed: false,
      isDestroyed: () => win.destroyed,
      destroy: () => { win.destroyed = true; destroyed.push(win.name); },
    };
    created.push(win);
    return win;
  };

  const pool = new BrowserPool(1, {
    create: async (sessionName) => make(sessionName) as unknown as Electron.BrowserWindow,
    destroy: (w) => (w as unknown as FakeWindow).destroy(),
  });

  return { pool, created, destroyed };
}

const as = (w: FakeWindow) => w as unknown as Electron.BrowserWindow;

describe('BrowserPool idle cap', () => {
  it('caps retained idle windows across all sessions, not per session', async () => {
    const { pool, created, destroyed } = harness();

    // /v1 derives the session from the hostname, so this is what a scraper walking a list of
    // hosts does: one distinct session name per host, each solved once and released.
    for (let i = 0; i < 12; i++) {
      const win = await pool.acquire(`host-${i}.test`);
      pool.release(win);
    }

    expect(created.length).toBe(12);
    expect(pool.idleCount).toBe(MAX_IDLE_WINDOWS);
    expect(pool.total).toBe(MAX_IDLE_WINDOWS);
    expect(destroyed.length).toBe(12 - MAX_IDLE_WINDOWS);
  });

  it('evicts the least recently released window first', async () => {
    const { pool, destroyed } = harness();

    const names: string[] = [];
    for (let i = 0; i < MAX_IDLE_WINDOWS; i++) {
      const win = await pool.acquire(`host-${i}.test`);
      names.push((win as unknown as FakeWindow).name);
      pool.release(win);
    }
    expect(destroyed).toEqual([]);

    // One more release puts the pool over the cap. The window released longest ago goes.
    const extra = await pool.acquire('newcomer.test');
    pool.release(extra);

    expect(destroyed).toEqual([names[0]]);
    expect(pool.idleCount).toBe(MAX_IDLE_WINDOWS);

    // And the one after that takes the next-oldest, not the newcomer.
    const another = await pool.acquire('newcomer2.test');
    pool.release(another);
    expect(destroyed).toEqual([names[0], names[1]]);
  });

  it('re-releasing a window refreshes its place in the eviction order', async () => {
    const { pool, destroyed } = harness();

    const first = await pool.acquire('a.test');
    const firstName = (first as unknown as FakeWindow).name;
    pool.release(first);
    for (let i = 1; i < MAX_IDLE_WINDOWS; i++) pool.release(await pool.acquire(`h-${i}.test`));

    // Touch `a.test` again. Its window comes out of the idle list and goes back on the end.
    const again = await pool.acquire('a.test');
    expect((again as unknown as FakeWindow).name).toBe(firstName);
    expect(pool.idleCount).toBe(MAX_IDLE_WINDOWS - 1);
    pool.release(again);

    pool.release(await pool.acquire('overflow.test'));

    // `h-1`, not `a.test`, is now the oldest.
    expect(destroyed).toEqual(['h-1.test#2']);
  });

  it('never evicts a window that is in use', async () => {
    const { pool, destroyed } = harness();

    // Held open — mid-solve, never released.
    const held = await pool.acquire('busy.test');
    const heldName = (held as unknown as FakeWindow).name;

    for (let i = 0; i < 20; i++) pool.release(await pool.acquire(`host-${i}.test`));

    expect(destroyed).not.toContain(heldName);
    expect((held as unknown as FakeWindow).destroyed).toBe(false);
    expect(pool.busy).toBe(1);
    // The cap counts idle windows; the in-use one is extra and outside it.
    expect(pool.idleCount).toBe(MAX_IDLE_WINDOWS);
    expect(pool.total).toBe(MAX_IDLE_WINDOWS + 1);
  });

  it('honours an explicit cap', async () => {
    const created: FakeWindow[] = [];
    const destroyed: string[] = [];
    const pool = new BrowserPool(1, {
      maxIdle: 2,
      create: async (name) => {
        const win: FakeWindow = {
          name: `${name}#${created.length + 1}`,
          destroyed: false,
          isDestroyed: () => win.destroyed,
          destroy: () => { win.destroyed = true; destroyed.push(win.name); },
        };
        created.push(win);
        return as(win);
      },
      destroy: (w) => (w as unknown as FakeWindow).destroy(),
    });

    for (let i = 0; i < 6; i++) pool.release(await pool.acquire(`host-${i}.test`));
    expect(pool.idleCount).toBe(2);
    expect(destroyed.length).toBe(4);
  });
});

describe('BrowserPool bookkeeping', () => {
  it('drains a window that died while idle instead of handing it out', async () => {
    const { pool, created } = harness();

    const win = await pool.acquire('a.test');
    pool.release(win);
    (win as unknown as FakeWindow).destroyed = true;

    const next = await pool.acquire('a.test');
    expect(next).not.toBe(win);
    expect(created.length).toBe(2);
    // The corpse is not still counted, and not still in the eviction order.
    expect(pool.total).toBe(1);
    expect(pool.idleCount).toBe(0);
  });

  it('does not retain a window released after it was destroyed', async () => {
    const { pool } = harness();

    const win = await pool.acquire('a.test');
    (win as unknown as FakeWindow).destroyed = true;
    pool.release(win);

    expect(pool.total).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(pool.busy).toBe(0);
  });

  it('reuses the retained window for a session rather than building a second', async () => {
    const { pool, created } = harness();

    const first = await pool.acquire('a.test');
    pool.release(first);
    const second = await pool.acquire('a.test');

    expect(second).toBe(first);
    expect(created.length).toBe(1);
  });
});

describe('BrowserPool.destroySession', () => {
  it('destroys the retained window for that session and no other', async () => {
    const { pool, destroyed } = harness();

    const a = await pool.acquire('a.test');
    const aName = (a as unknown as FakeWindow).name;
    pool.release(a);
    const b = await pool.acquire('b.test');
    pool.release(b);

    pool.destroySession('a.test');

    expect(destroyed).toEqual([aName]);
    expect(pool.total).toBe(1);
    expect(pool.idleCount).toBe(1);

    // And the next solve on that name gets a fresh window, not the cleared one back.
    const again = await pool.acquire('a.test');
    expect(again).not.toBe(a);
  });

  it('is a no-op for a session that holds nothing', async () => {
    const { pool, destroyed } = harness();
    pool.destroySession('never-seen.test');
    expect(destroyed).toEqual([]);
  });

  it('leaves a window that is currently in use alone', async () => {
    const { pool, destroyed } = harness();

    const busy = await pool.acquire('a.test');
    pool.destroySession('a.test');

    expect(destroyed).toEqual([]);
    expect((busy as unknown as FakeWindow).destroyed).toBe(false);
  });
});
