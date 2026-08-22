import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startGatehouse, type Harness } from './harness.js';
import { startCloudflareFixture, PAYLOAD_MARKER, type Fixture } from '../fixture/cloudflare.js';

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
    const before = fx.paths.filter((p) => p === '/cdn-cgi/verify').length;
    const { json } = await v1({ cmd: 'request.get', url: fx.url + '/', maxTimeout: 70000 });

    expect(json.solution.response).toContain(PAYLOAD_MARKER);
    // The partition already holds the clearance, so no second verify hop was needed.
    expect(fx.paths.filter((p) => p === '/cdn-cgi/verify').length).toBe(before);
  }, 60_000);

  it('fails cleanly on an interactive challenge instead of hanging', async () => {
    const interactive = await startCloudflareFixture({ mode: 'interactive' });
    try {
      const { status, json } = await v1({ cmd: 'request.get', url: interactive.url + '/', maxTimeout: 8000 });
      expect(status).toBe(500);
      expect(json.status).toBe('error');
      expect(json.message).toMatch(/interactive/i);
    } finally {
      await interactive.close();
    }
  }, 60_000);

  it('reports health', async () => {
    const res = await fetch(`${gh.url}/gh/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as any).browsers).toBeDefined();
  });
});
