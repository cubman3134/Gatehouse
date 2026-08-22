import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { startGatehouse, type Harness } from './harness.js';
import { startCloudflareFixture, PAYLOAD_MARKER, type Fixture } from '../fixture/cloudflare.js';

/**
 * A server that completes the TCP handshake, reads the request, and then never answers —
 * the shape that makes an unbounded navigation hang forever. Sockets are tracked so the
 * close can destroy them; `server.close()` alone waits for connections that never end.
 */
async function startStallingServer(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer(() => { /* deliberately never responds */ });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}

let gh: Harness;
beforeAll(async () => { gh = await startGatehouse(); }, 60_000);
afterAll(async () => { await gh?.stop(); });

async function v1(body: object) {
  const res = await fetch(`${gh.url}/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe('the real app against the fake Cloudflare', () => {
  let fx: Fixture;
  afterAll(async () => { await fx?.close(); });

  it('clears the JS challenge and returns what the client reads', async () => {
    fx = await startCloudflareFixture();

    const { status, json } = await v1({ cmd: 'request.get', url: fx.url + '/', maxTimeout: 70000 });

    expect(status).toBe(200);
    expect(json.status).toBe('ok');

    // The two fields a FlareSolverr client actually reads.
    expect(json.solution.userAgent).toBeTruthy();
    const clearance = json.solution.cookies.find((c: any) => c.name === 'cf_clearance');
    expect(clearance?.value).toBe(fx.secret);

    // And the solved body really is the protected page, not the interstitial.
    expect(json.solution.response).toContain(PAYLOAD_MARKER);
    expect(json.solution.status).toBe(200);
  }, 60_000);

  it('reuses the cleared partition on a second request to the same session', async () => {
    const beforeVerifies = fx.paths.filter((p) => p === '/cdn-cgi/verify').length;
    const beforeRequests = fx.paths.length;
    const { json } = await v1({ cmd: 'request.get', url: fx.url + '/', maxTimeout: 70000 });

    expect(json.solution.response).toContain(PAYLOAD_MARKER);
    // A Chromium cache hit would also leave the verify count alone while never sending the
    // cookie at all, so the fixture must show it was actually asked — and asked without
    // being sent back through the challenge.
    expect(fx.paths.length).toBeGreaterThan(beforeRequests);
    expect(fx.paths.filter((p) => p === '/cdn-cgi/verify').length).toBe(beforeVerifies);
  }, 60_000);

  /**
   * THE CASE THE PRODUCT EXISTS FOR. Cloudflare's managed challenge draws a Turnstile widget
   * while it solves itself — measured on a real host, widget at t=1s, cleared at t=2s, no
   * human anywhere. Reading that widget as "needs a person" aborted the solve one second
   * before it would have succeeded, which is this whole bug. Gatehouse must sit through it
   * and come back with the payload.
   */
  it('solves a managed challenge that shows a turnstile widget and then clears itself', async () => {
    const managed = await startCloudflareFixture({ mode: 'managed', managedSolveDelayMs: 1500 });
    try {
      const { status, json } = await v1({
        cmd: 'request.get',
        url: managed.url + '/',
        session: 'managed',
        maxTimeout: 30000,
      });

      expect(status).toBe(200);
      expect(json.status).toBe('ok');
      expect(json.solution.response).toContain(PAYLOAD_MARKER);
      expect(json.solution.status).toBe(200);
      const clearance = json.solution.cookies.find((c: any) => c.name === 'cf_clearance');
      expect(clearance?.value).toBe(managed.secret);
      // It really did go through the challenge — the auto-verify hop was taken, so the poll
      // loop sat on a page carrying a turnstile widget rather than bailing on it.
      expect(managed.paths).toContain('/cdn-cgi/verify');
    } finally {
      await managed.close();
    }
  }, 60_000);

  /**
   * A challenge that genuinely never clears must still fail — but at the deadline, not on
   * sight of a widget. The message names the interactive possibility; the code stays
   * `challenge-failed` (there is no `pending-human` path until increment 3).
   */
  it('runs an interactive challenge to its deadline and then fails cleanly', async () => {
    const interactive = await startCloudflareFixture({ mode: 'interactive' });
    try {
      const began = Date.now();
      const { status, json } = await v1({ cmd: 'request.get', url: interactive.url + '/', maxTimeout: 4000 });
      const elapsed = Date.now() - began;

      expect(status).toBe(500);
      expect(json.status).toBe('error');
      expect(json.message).toMatch(/interactive/i);
      expect(json.message).toMatch(/4000ms/);
      // It waited: the old behaviour refused on the first snapshot, well inside a second.
      expect(elapsed).toBeGreaterThan(3000);
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await interactive.close();
    }
  }, 60_000);

  it('reports health', async () => {
    const res = await fetch(`${gh.url}/gh/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).browsers).toBeDefined();
  });

  /**
   * Two concurrent solves on ONE session name. The pool only reuses a window that is idle,
   * so this builds a second BrowserWindow on the same `persist:` partition — and a partition
   * is one Electron Session, whose `onHeadersReceived` is a single slot. A per-solve
   * registration therefore evicts its neighbour's, and the evicted solve sees `status: 0`
   * and no headers for its whole run: no `cf-mitigated`, no challenge signal from the
   * headers, and an interstitial one marker away from being judged `clear` and handed back
   * as content. Shipped defaults reach this: concurrency is 2 and /v1 derives the session
   * from the hostname, so two paths on one host are two concurrent jobs on one session.
   */
  it('keeps both solves intact when two run concurrently on one session', async () => {
    const two = await startCloudflareFixture();
    try {
      const get = (path: string) =>
        v1({ cmd: 'request.get', url: two.url + path, session: 'concurrent', maxTimeout: 30000 });

      const [a, b] = await Promise.all([get('/alpha'), get('/beta')]);

      for (const r of [a, b]) {
        expect(r.status).toBe(200);
        expect(r.json.status).toBe('ok');
        expect(r.json.solution.response).toContain(PAYLOAD_MARKER);
        // The captured main-frame status and headers are per-solve state. A shared listener
        // leaves one of the two at its initializer.
        expect(r.json.solution.status).toBe(200);
        expect(Object.keys(r.json.solution.headers).length).toBeGreaterThan(0);
        const clearance = r.json.solution.cookies.find((c: any) => c.name === 'cf_clearance');
        expect(clearance?.value).toBe(two.secret);
      }
    } finally {
      await two.close();
    }
  }, 90_000);

  /**
   * maxTimeout has to bound the navigation, not just the poll loop. A host that accepts the
   * connection and then says nothing used to hold `loadURL` open forever, pinning a pool
   * window and a queue slot; two of them wedge the service at the default concurrency.
   */
  it('gives up on a host that accepts the connection and never answers', async () => {
    const stall = await startStallingServer();
    try {
      const began = Date.now();
      const { status, json } = await v1({
        cmd: 'request.get',
        url: stall.url + '/',
        session: 'stalled',
        maxTimeout: 4000,
      });
      const elapsed = Date.now() - began;

      expect(status).toBe(500);
      expect(json.status).toBe('error');
      expect(json.message).toMatch(/did not complete within 4000ms/);
      // It must actually be the deadline that ended it, not some other early failure, and it
      // must not run long past it.
      expect(elapsed).toBeGreaterThan(3000);
      expect(elapsed).toBeLessThan(30_000);
    } finally {
      await stall.close();
    }
  }, 60_000);
});
