import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startGatehouse, type Harness } from './harness.js';
import { startCloudflareFixture, type Fixture } from '../fixture/cloudflare.js';

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

describe('sessions.destroy against the real app', () => {
  let fx: Fixture;
  afterAll(async () => { await fx?.close(); });

  it('tears down a real pooled window and partition without erroring', async () => {
    fx = await startCloudflareFixture();

    const first = await v1({ cmd: 'request.get', url: fx.url + '/', session: 'teardown', maxTimeout: 70000 });
    expect(first.json.status).toBe('ok');

    const health = await (await fetch(`${gh.url}/gh/health`)).json() as any;
    expect(health.browsers.total).toBe(1);

    const gone = await v1({ cmd: 'sessions.destroy', session: 'teardown' });
    expect(gone.status).toBe(200);
    expect(gone.json.status).toBe('ok');

    const after = await (await fetch(`${gh.url}/gh/health`)).json() as any;
    expect(after.browsers.total).toBe(0);

    // And the app is still alive and solving afterwards.
    const again = await v1({ cmd: 'request.get', url: fx.url + '/', session: 'teardown', maxTimeout: 70000 });
    expect(again.json.status).toBe('ok');
  }, 90_000);
});
