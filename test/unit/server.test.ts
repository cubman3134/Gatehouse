import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer, PortInUseError, type ServerHandle } from '../../src/api/server.js';
import type { V1Deps, Solution } from '../../src/api/v1.js';
import { ConfigError, loadConfig } from '../../src/config.js';

const solution: Solution = {
  url: 'http://example.test/', status: 200, headers: {},
  cookies: [{ name: 'cf_clearance', value: 'abc', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: false }],
  userAgent: 'UA/1', response: '<html>ok</html>',
};

const deps = (): V1Deps => ({ solve: vi.fn(async () => solution), now: () => 1, version: 'test', sessions: new Set() });
const health = () => ({ version: 'test', browsers: { busy: 0, total: 0 }, queue: { depth: 0 } });

let h: ServerHandle | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('startServer', () => {
  it('serves /v1 on a loopback bind with no Authorization header', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);

    const res = await fetch(`http://127.0.0.1:${h.port}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: 'http://example.test/', maxTimeout: 70000 }),
    });

    expect(res.status).toBe(200);
    expect((await res.json() as any).solution.userAgent).toBe('UA/1');
  });

  it('serves /gh/health', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/gh/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).version).toBe('test');
  });

  it('404s an unknown path', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    expect((await fetch(`http://127.0.0.1:${h.port}/nope`)).status).toBe(404);
  });

  it('405s a GET on /v1', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    expect((await fetch(`http://127.0.0.1:${h.port}/v1`)).status).toBe(405);
  });

  it('serves a HEAD on /gh/health', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/gh/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });

  it('returns the error shape, not a crash, for malformed JSON', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    expect(res.status).toBe(500);

    // v1's own error shape, key for key — the point of routing this through `fail`.
    const body = await res.json() as any;
    expect(Object.keys(body).sort()).toEqual(
      ['endTimestamp', 'message', 'startTimestamp', 'status', 'version'].sort(),
    );
    expect(body.status).toBe('error');
    expect('solution' in body).toBe(false);
  });

  // A reset reads to a FlareSolverr client as "solver unavailable"; a 500 with the error shape
  // reads as "that request was bad". The oversized body must produce the second.
  it('answers an oversized body with a 500, not a connection reset', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(2_000_000),
    });
    expect(res.status).toBe(500);
    expect((await res.json() as any).status).toBe('error');
  });

  // `onError` is removed once listening; without a permanent replacement an accept-time
  // failure (EMFILE) is an unhandled 'error' event, which throws and kills the daemon.
  it('survives a server-level error after startup', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    expect(() => h!.server.emit('error', new Error('boom'))).not.toThrow();

    const res = await fetch(`http://127.0.0.1:${h.port}/gh/health`);
    expect(res.status).toBe(200);
  });

  it('requires a bearer token on a non-loopback bind', async () => {
    const cfg = { ...loadConfig({ GATEHOUSE_PORT: '0' }), bind: '0.0.0.0', token: 'sekrit' };
    h = await startServer(cfg, deps(), health);

    const noAuth = await fetch(`http://127.0.0.1:${h.port}/gh/health`);
    expect(noAuth.status).toBe(401);

    const withAuth = await fetch(`http://127.0.0.1:${h.port}/gh/health`, {
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(withAuth.status).toBe(200);
  });

  it('rejects a wrong token', async () => {
    const cfg = { ...loadConfig({ GATEHOUSE_PORT: '0' }), bind: '0.0.0.0', token: 'sekrit' };
    h = await startServer(cfg, deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/gh/health`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
  });

  // Both wrong-token cases above differ in length, so a `startsWith` comparison would pass
  // them. A strict extension of the real token is what has teeth: knowing a prefix must not
  // authenticate.
  it('rejects a token that merely starts with the real one', async () => {
    const cfg = { ...loadConfig({ GATEHOUSE_PORT: '0' }), bind: '0.0.0.0', token: 'sekrit' };
    h = await startServer(cfg, deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/gh/health`, {
      headers: { authorization: 'Bearer sekrit-extra' },
    });
    expect(res.status).toBe(401);
  });

  // RFC 7235: the auth-scheme is case-insensitive. The credential after it is not.
  it('accepts a lowercase bearer scheme', async () => {
    const cfg = { ...loadConfig({ GATEHOUSE_PORT: '0' }), bind: '0.0.0.0', token: 'sekrit' };
    h = await startServer(cfg, deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/gh/health`, {
      headers: { authorization: 'bearer sekrit' },
    });
    expect(res.status).toBe(200);
  });

  // The gate exempts loopback on the strength of the configured bind string. If what `listen`
  // actually bound is reachable and no token is set, starting up would leave the door open.
  it('refuses to serve when the bound address is reachable and no token is set', async () => {
    const cfg = { ...loadConfig({ GATEHOUSE_PORT: '0' }), bind: '0.0.0.0', token: null };
    await expect(startServer(cfg, deps(), health)).rejects.toThrow(ConfigError);
  });

  // Port 8191 is FlareSolverr's own. A silent fallback to another port would leave the
  // operator unsure which of the two Allarr is talking to.
  it('throws PortInUseError naming the port when the bind is taken', async () => {
    const squatter = createServer((_, res) => res.end());
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r));
    const taken = (squatter.address() as AddressInfo).port;

    try {
      const cfg = { ...loadConfig({}), port: taken };
      await expect(startServer(cfg, deps(), health)).rejects.toThrow(PortInUseError);
      await expect(startServer(cfg, deps(), health)).rejects.toThrow(new RegExp(String(taken)));

      // The FlareSolverr sentence misdirects when the operator picked their own port: they
      // are not fighting FlareSolverr for 8191. The refusal-to-fall-back explanation stays.
      await expect(startServer(cfg, deps(), health)).rejects.toThrow(/Refusing to fall back/);
      const message = await startServer(cfg, deps(), health).catch((e: Error) => e.message);
      expect(message).not.toMatch(/8191/);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});
