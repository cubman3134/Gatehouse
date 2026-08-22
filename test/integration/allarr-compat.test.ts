import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startGatehouse, type Harness } from './harness.js';
import { startCloudflareFixture, PAYLOAD_MARKER, type Fixture } from '../fixture/cloudflare.js';

/**
 * The increment's acceptance gate.
 *
 * A separate application already speaks FlareSolverr's `/v1` protocol and cannot be
 * modified; the whole premise of increment 1 is that pointing its `FlareSolverrUrl` at
 * Gatehouse works with zero changes on its side. This file is a byte-level replay of what
 * that client puts on the wire, and asserts precisely the fields it reads back — no more,
 * so the test cannot fail on a field nobody consumes, and no less, so it cannot pass on a
 * server that is missing what the client needs.
 *
 * If this file goes red the increment is void, however green the other suites are.
 */

/**
 * The literal request body. Its C# origin is
 *
 *     JsonSerializer.Serialize(new { cmd, url, maxTimeout })
 *
 * so the property ORDER is part of the wire image, not an accident of formatting. It is
 * built as a string rather than via JSON.stringify of an object literal so that a future
 * edit to the shape is visible as a change to these bytes.
 */
function allarrPayload(url: string, maxTimeout = 70000): string {
  return `{"cmd":"request.get","url":"${url}","maxTimeout":${maxTimeout}}`;
}

let gh: Harness;
let fx: Fixture;

/** Exactly what the client observes: a status code and a body of bytes. */
let status = 0;
let ok = false;
let bodyText = '';
let doc: any;

beforeAll(async () => {
  gh = await startGatehouse();
  fx = await startCloudflareFixture();

  const res = await fetch(`${gh.url}/v1`, {
    method: 'POST',
    // The client posts `new StringContent(payload, Encoding.UTF8, "application/json")`,
    // which lands on the wire as this exact header, and sends NO Authorization header —
    // Gatehouse's loopback bind must therefore take none.
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: allarrPayload(`${fx.url}/`),
  });

  status = res.status;
  ok = res.ok;
  bodyText = await res.text();
  try {
    doc = JSON.parse(bodyText);
  } catch {
    doc = undefined;
  }
}, 120_000);

afterAll(async () => {
  await gh?.stop();
  await fx?.close();
});

describe('the wire contract of an unmodifiable FlareSolverr client', () => {
  it('answers a success status, which is the only thing gating the client from degrading', () => {
    // `response.IsSuccessStatusCode`. Anything else and the client concludes the solver is
    // unavailable and gives up on the host, so this single bit decides the whole feature.
    expect(ok, `status ${status}, body: ${bodyText.slice(0, 200)}`).toBe(true);
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
  });

  it('answers a JSON body carrying a solution object', () => {
    // `JsonDocument.Parse(body).RootElement.GetProperty("solution")` — both must succeed.
    expect(doc, `body was not JSON: ${bodyText.slice(0, 200)}`).toBeDefined();
    expect(typeof doc.solution).toBe('object');
    expect(doc.solution).not.toBeNull();
  });

  it('carries a non-empty solution.userAgent', () => {
    // The client copies this verbatim onto the requests it then makes itself. An absent or
    // empty one leaves those requests with a mismatched agent, which the origin rejects.
    expect(typeof doc.solution.userAgent).toBe('string');
    expect(doc.solution.userAgent.length).toBeGreaterThan(0);
  });

  it('carries a cf_clearance entry in solution.cookies with a non-empty value', () => {
    // The client scans the array by `name === "cf_clearance"` and takes `.value`.
    expect(Array.isArray(doc.solution.cookies)).toBe(true);
    const cf = doc.solution.cookies.find((c: any) => c.name === 'cf_clearance');
    expect(cf, `no cf_clearance in ${JSON.stringify(doc.solution.cookies)}`).toBeDefined();
    expect(typeof cf.value).toBe('string');
    expect(cf.value.length).toBeGreaterThan(0);
  });

  /**
   * The two fields are not read for their own sake — the client replays them at the origin.
   * A server could satisfy every assertion above with a well-formed but useless answer, so
   * this does what the client does next: a plain fetch carrying the minted cookie and agent.
   * `test/unit/fixture.test.ts` pins that the same fetch WITHOUT them cannot get through.
   */
  it('mints a cookie and agent that actually get the client through the origin', async () => {
    const cf = doc.solution.cookies.find((c: any) => c.name === 'cf_clearance');

    const replay = await fetch(`${fx.url}/`, {
      headers: {
        cookie: `cf_clearance=${cf.value}`,
        'user-agent': doc.solution.userAgent,
      },
    });

    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain(PAYLOAD_MARKER);
  }, 30_000);

  /**
   * The other half of the contract: the client's failure path. It treats any non-2xx as
   * "solver unavailable" and degrades, so a failure must NOT arrive as a 200 with an error
   * body — that would be read as a success with no cf_clearance and no way to tell why.
   */
  it('answers a failure with the non-2xx the client degrades on', async () => {
    // Port 1 refuses the connection immediately; there is no solving this.
    const res = await fetch(`${gh.url}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: allarrPayload('http://127.0.0.1:1/', 8000),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).status).toBe('error');
  }, 60_000);
});
