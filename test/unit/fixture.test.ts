import { describe, it, expect, afterEach } from 'vitest';
import { startCloudflareFixture, PAYLOAD_MARKER, type Fixture } from '../fixture/cloudflare.js';

let fx: Fixture | undefined;
afterEach(async () => { await fx?.close(); fx = undefined; });

describe('fake Cloudflare fixture', () => {
  // THE TEETH TEST. If a plain fetch can reach the payload, the fixture simulates
  // nothing and every test built on it is worthless.
  it('refuses a plain fetch that cannot run JavaScript', async () => {
    fx = await startCloudflareFixture();
    const res = await fetch(fx.url);
    const body = await res.text();

    expect(res.status).toBe(503);
    expect(res.headers.get('cf-mitigated')).toBe('challenge');
    expect(body).not.toContain(PAYLOAD_MARKER);
    expect(body).toContain('challenge-form');
  });

  it('serves the payload once the clearance cookie is presented', async () => {
    fx = await startCloudflareFixture();
    const res = await fetch(fx.url, { headers: { cookie: `cf_clearance=${fx.secret}` } });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(PAYLOAD_MARKER);
  });

  it('rejects a wrong clearance cookie', async () => {
    fx = await startCloudflareFixture();
    const res = await fetch(fx.url, { headers: { cookie: 'cf_clearance=wrong' } });
    expect(res.status).toBe(503);
  });

  it('mints the cookie on the verify hop and redirects home', async () => {
    fx = await startCloudflareFixture();
    const res = await fetch(new URL('/cdn-cgi/verify', fx.url), { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('cf_clearance=');
  });

  // Interactive mode must NOT be auto-solvable, or `pending-human` is never exercised.
  it('interactive mode serves no auto-verify script', async () => {
    fx = await startCloudflareFixture({ mode: 'interactive' });
    const body = await (await fetch(fx.url)).text();

    expect(body).toContain('cf-turnstile');
    expect(body).not.toContain('/cdn-cgi/verify');
  });

  it('records the paths it was asked for', async () => {
    fx = await startCloudflareFixture();
    await fetch(fx.url);
    expect(fx.paths).toContain('/');
  });
});
