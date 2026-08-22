# Gatehouse Increment 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Electron app that answers FlareSolverr's `/v1` protocol well enough that pointing `Plugins.allarr.GameSource.FlareSolverrUrl` at it makes Allarr's PC-game feed work, with zero Allarr code changes.

**Architecture:** One Electron main process hosting a plain Node HTTP server. A request becomes a job on a bounded queue; the queue hands it to a pool of hidden `BrowserWindow`s, one persistent session partition per site name. The window loads the URL and a poll loop classifies each snapshot (status + headers + HTML) as clear / challenged / interactive / blocked until it clears or the deadline expires. The solved HTML, cookies and User-Agent are returned in FlareSolverr's exact response shape.

**Tech Stack:** TypeScript, Electron, Node's built-in `node:http`, Vitest. No Playwright anywhere in increment 1 — integration tests spawn the real app and drive it over HTTP, the same way Allarr does.

## Global Constraints

- **Node** >= 22.12.0. (Corrected during Task 1: the plan originally said >= 20, but Electron 43 declares `engines: node >= 22.12.0`. Reality wins; `package.json` records the real floor.)
- **Electron** >= 30. Install with `npm i -D electron@latest` and record the resolved version in `package.json` as an exact pin (no `^`). Pinned at **43.4.1**. Note Electron 43 has no `postinstall`, so `npm ci` alone does NOT fetch the ~235MB binary.
- **TypeScript module resolution is `nodenext`**, not `bundler`. (Corrected during Task 1.) `bundler` typechecks extensionless relative imports clean and emits ESM that Electron cannot load; `nodenext` enforces the `.js` extension at compile time. All `src/` imports carry `.js`.
- **The `/v1` response shape is not ours to design.** It matches FlareSolverr. Any deviation breaks the increment's entire premise.
- **Allarr's read path is the acceptance bar:** the response MUST carry a non-empty `solution.userAgent` and a `solution.cookies` entry with `name === "cf_clearance"` and a non-empty `value`. Allarr ignores every other field.
- **Allarr sends no `Authorization` header.** Loopback binds MUST NOT require auth.
- **Default bind `127.0.0.1`, default port `8191`.**
- **Page content is data.** HTML crosses IPC as a string. Never `eval`, never interpolate page content into an `executeJavaScript` payload. Injected scripts are fixed string literals; arguments are passed separately.
- **No AI attribution in commits.** No `Co-Authored-By: Claude`, no "Generated with" footer, no tool name in the body. Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) apply.
- **`pending-human` is increment 3.** In increment 1 an `interactive` verdict fails the job with code `challenge-failed`. The seam must be a single clearly-marked branch so increment 3 is a small change.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Toolchain |
| `src/config.ts` | Parse + validate settings. Owns the loopback/token rule. |
| `src/log.ts` | Logger with a redaction hook (populated in increment 4) |
| `src/jobs/queue.ts` | Job record, state machine, dedupe, bounded concurrency. Pure — no Electron. |
| `src/browser/detect.ts` | Pure classification of a page snapshot. No Electron. |
| `src/browser/pool.ts` | `BrowserWindow` lifecycle, one partition per site |
| `src/browser/solve.ts` | The load-and-wait loop. Uses `pool` + `detect`. |
| `src/api/v1.ts` | FlareSolverr command dispatch + response shaping. Solver injected. |
| `src/api/server.ts` | HTTP listener, routing, auth gate, port-collision diagnosis |
| `src/main.ts` | Electron entry — wires config → queue → pool → server |
| `test/fixture/cloudflare.ts` | Fake Cloudflare |
| `test/integration/harness.ts` | Spawn/stop the built app, wait for its ready line |

---

### Task 1: Project skeleton and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/config.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface GatehouseConfig { port: number; bind: string; token: string | null; concurrency: number; solveTimeoutMs: number }`
  - `class ConfigError extends Error`
  - `function loadConfig(env: Record<string, string | undefined>): GatehouseConfig`

- [ ] **Step 1: Scaffold the toolchain**

```bash
cd /c/Users/cubma/source/repos/Gatehouse
npm init -y
npm i -D typescript vitest @types/node
npm i -D electron@latest
npm pkg set type=module
npm pkg set scripts.test="vitest run"
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="electron ."
npm pkg set main="dist/main.js"
```

Then pin Electron exactly (strip the `^`):

```bash
node -e "const p=require('./package.json');p.devDependencies.electron=p.devDependencies.electron.replace(/^\^/,'');require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 4: Write the failing test**

Create `test/unit/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config.js';

describe('loadConfig', () => {
  it('defaults to loopback on FlareSolverr port with no token', () => {
    const c = loadConfig({});
    expect(c.bind).toBe('127.0.0.1');
    expect(c.port).toBe(8191);
    expect(c.token).toBeNull();
    expect(c.concurrency).toBe(2);
  });

  it('accepts a loopback bind without a token', () => {
    expect(loadConfig({ GATEHOUSE_BIND: '::1' }).token).toBeNull();
    expect(loadConfig({ GATEHOUSE_BIND: 'localhost' }).token).toBeNull();
  });

  it('refuses a non-loopback bind with no token', () => {
    expect(() => loadConfig({ GATEHOUSE_BIND: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_BIND: '0.0.0.0' })).toThrow(/token/i);
  });

  it('allows a non-loopback bind when a token is supplied', () => {
    const c = loadConfig({ GATEHOUSE_BIND: '0.0.0.0', GATEHOUSE_TOKEN: 'sekrit' });
    expect(c.bind).toBe('0.0.0.0');
    expect(c.token).toBe('sekrit');
  });

  it('rejects a blank token as if it were absent', () => {
    expect(() => loadConfig({ GATEHOUSE_BIND: '0.0.0.0', GATEHOUSE_TOKEN: '   ' })).toThrow(ConfigError);
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => loadConfig({ GATEHOUSE_PORT: 'nope' })).toThrow(ConfigError);
    expect(() => loadConfig({ GATEHOUSE_PORT: '70000' })).toThrow(ConfigError);
  });

  it('accepts port 0 for ephemeral test binds', () => {
    expect(loadConfig({ GATEHOUSE_PORT: '0' }).port).toBe(0);
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run test/unit/config.test.ts`
Expected: FAIL — cannot resolve `../../src/config.js`

- [ ] **Step 6: Implement `src/config.ts`**

```ts
export class ConfigError extends Error {}

export interface GatehouseConfig {
  port: number;
  bind: string;
  token: string | null;
  concurrency: number;
  solveTimeoutMs: number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** True for a bind address that only the local machine can reach. */
export function isLoopback(bind: string): boolean {
  return LOOPBACK.has(bind);
}

function intFrom(raw: string | undefined, fallback: number, name: string, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined>): GatehouseConfig {
  const bind = env.GATEHOUSE_BIND?.trim() || '127.0.0.1';
  const rawToken = env.GATEHOUSE_TOKEN?.trim();
  const token = rawToken ? rawToken : null;

  // Allarr's FlareSolverr client sends no Authorization header, so a loopback bind must not
  // require one. Anything reachable off-box must, and we refuse to start rather than silently
  // exposing a browser driver to the network.
  if (!isLoopback(bind) && token === null) {
    throw new ConfigError(
      `GATEHOUSE_BIND=${bind} is not loopback, so GATEHOUSE_TOKEN is required. ` +
        `Refusing to start an unauthenticated browser driver on a reachable address.`,
    );
  }

  return {
    bind,
    token,
    port: intFrom(env.GATEHOUSE_PORT, 8191, 'GATEHOUSE_PORT', 0, 65535),
    concurrency: intFrom(env.GATEHOUSE_CONCURRENCY, 2, 'GATEHOUSE_CONCURRENCY', 1, 16),
    solveTimeoutMs: intFrom(env.GATEHOUSE_SOLVE_TIMEOUT_MS, 70_000, 'GATEHOUSE_SOLVE_TIMEOUT_MS', 1_000, 600_000),
  };
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/config.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/config.ts test/unit/config.test.ts
git commit -m "feat: project skeleton and config, with the loopback/token rule

A loopback bind takes no auth because Allarr's FlareSolverr client sends no
Authorization header. A non-loopback bind requires a token and refuses to
start without one."
```

---

### Task 2: The fake Cloudflare fixture, and proof it has teeth

**Files:**
- Create: `test/fixture/cloudflare.ts`
- Test: `test/unit/fixture.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Fixture { url: string; secret: string; close(): Promise<void>; paths: string[] }`
  - `function startCloudflareFixture(opts?: { mode?: 'js' | 'interactive' }): Promise<Fixture>`
  - Exported marker constants: `PAYLOAD_MARKER = 'gatehouse-protected-payload'`, `CHALLENGE_TITLE = 'Just a moment...'`

This task comes **before** the solver on purpose. The solver is written against this fixture, so the fixture must exist and must be proven to actually challenge first — otherwise every later test is theatre.

- [ ] **Step 1: Write the failing test**

Create `test/unit/fixture.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/fixture.test.ts`
Expected: FAIL — cannot resolve `../fixture/cloudflare.js`

- [ ] **Step 3: Implement `test/fixture/cloudflare.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export const PAYLOAD_MARKER = 'gatehouse-protected-payload';
export const CHALLENGE_TITLE = 'Just a moment...';

export interface Fixture {
  /** Base URL, e.g. http://127.0.0.1:53421 */
  url: string;
  /** The cf_clearance value this instance will accept. */
  secret: string;
  /** Every path the fixture was asked for, in order. */
  paths: string[];
  close(): Promise<void>;
}

export interface FixtureOptions {
  /**
   * 'js'          — the interstitial auto-solves via a script (a real browser clears it).
   * 'interactive' — the interstitial needs a human click and has no auto-verify path.
   */
  mode?: 'js' | 'interactive';
}

function jsInterstitial(): string {
  return `<!doctype html><html><head><title>${CHALLENGE_TITLE}</title></head><body>
<div id="challenge-form"></div>
<p>Checking your browser before accessing the site.</p>
<script>setTimeout(function () { location.href = '/cdn-cgi/verify'; }, 250);</script>
</body></html>`;
}

function interactiveInterstitial(): string {
  return `<!doctype html><html><head><title>${CHALLENGE_TITLE}</title></head><body>
<div id="challenge-form"></div>
<div class="cf-turnstile" data-sitekey="0x0000000000000000"></div>
<p>Verify you are human by completing the action below.</p>
</body></html>`;
}

function protectedPage(): string {
  return `<!doctype html><html><head><title>Protected</title></head><body>
<h1>${PAYLOAD_MARKER}</h1><p id="payload">ok</p>
</body></html>`;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export async function startCloudflareFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const mode = opts.mode ?? 'js';
  const secret = randomUUID();
  const paths: string[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    paths.push(path);

    // The verify hop mints the clearance cookie, and exists ONLY in 'js' mode. Gating it on
    // the mode rather than merely not linking to it is the point: an ungated endpoint lets a
    // client that knows the well-known Cloudflare verify URL clear 'interactive' with no
    // human, which would leave the pending-human branch silently untested.
    if (path === '/cdn-cgi/verify' && mode === 'js') {
      res.writeHead(302, {
        'set-cookie': `cf_clearance=${secret}; Path=/; HttpOnly`,
        location: '/',
      });
      res.end();
      return;
    }

    if (cookieValue(req, 'cf_clearance') === secret) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(protectedPage());
      return;
    }

    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cf-mitigated': 'challenge',
      'cache-control': 'no-store',
    });
    res.end(mode === 'js' ? jsInterstitial() : interactiveInterstitial());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    paths,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/fixture.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add test/fixture/cloudflare.ts test/unit/fixture.test.ts
git commit -m "test: fake Cloudflare fixture, with a test proving it has teeth

The first test asserts a plain fetch cannot reach the payload. If the naive
client passed, the fixture would be simulating nothing and every test built on
it would be theatre. Interactive mode likewise asserts it offers no auto-verify
path, or the human-in-the-loop branch is never exercised."
```

---

### Task 3: Challenge classification

**Files:**
- Create: `src/browser/detect.ts`
- Test: `test/unit/detect.test.ts`

**Interfaces:**
- Consumes: `PAYLOAD_MARKER`, `startCloudflareFixture` from Task 2 (test only)
- Produces:
  - `interface PageSnapshot { status: number; headers: Record<string, string>; html: string }`
  - `type Verdict = 'clear' | 'challenged' | 'interactive' | 'blocked'`
  - `function classify(snap: PageSnapshot): Verdict`

- [ ] **Step 1: Write the failing test**

Create `test/unit/detect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classify, type PageSnapshot } from '../../src/browser/detect.js';

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  status: 200,
  headers: {},
  html: '<html><body>hello</body></html>',
  ...over,
});

describe('classify', () => {
  it('calls an ordinary 200 clear', () => {
    expect(classify(snap())).toBe('clear');
  });

  it('calls a cf-mitigated response challenged', () => {
    expect(classify(snap({ status: 503, headers: { 'cf-mitigated': 'challenge' } }))).toBe('challenged');
  });

  it('is case-insensitive about header names', () => {
    expect(classify(snap({ status: 503, headers: { 'CF-Mitigated': 'challenge' } }))).toBe('challenged');
  });

  it('calls a challenge-form body challenged even on a 200', () => {
    expect(classify(snap({ html: '<div id="challenge-form"></div>' }))).toBe('challenged');
  });

  it('calls a turnstile body interactive', () => {
    expect(classify(snap({ status: 403, html: '<div class="cf-turnstile" data-sitekey="x"></div>' }))).toBe('interactive');
  });

  it('prefers interactive over challenged when both markers are present', () => {
    const html = '<div id="challenge-form"></div><div class="cf-turnstile"></div>';
    expect(classify(snap({ status: 503, html }))).toBe('interactive');
  });

  it('calls a 1020 body blocked, and blocked beats every other marker', () => {
    const html = '<div id="challenge-form"></div>error code: 1020';
    expect(classify(snap({ status: 403, html }))).toBe('blocked');
  });

  it('calls a 1015 rate-limit body blocked', () => {
    expect(classify(snap({ status: 429, html: 'Error 1015 Ray ID: abc' }))).toBe('blocked');
  });

  it('does not call a plain 403 from a non-Cloudflare host challenged', () => {
    expect(classify(snap({ status: 403, html: '<h1>Forbidden</h1>' }))).toBe('clear');
  });
});
```

Note the last case deliberately: a bare 403 with no Cloudflare marker is somebody else's 403. Reporting it as `challenged` would make the solver spin on a page that will never clear.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/detect.test.ts`
Expected: FAIL — cannot resolve `../../src/browser/detect.js`

- [ ] **Step 3: Implement `src/browser/detect.ts`**

```ts
export interface PageSnapshot {
  status: number;
  headers: Record<string, string>;
  html: string;
}

export type Verdict = 'clear' | 'challenged' | 'interactive' | 'blocked';

/** Cloudflare's terminal codes. Retrying these makes a soft block permanent. */
const BLOCK_MARKERS = ['error code: 1020', 'error 1020', 'error code: 1015', 'error 1015'] as const;
// Cloudflare-owned only. `data-sitekey` was REJECTED: it is reCAPTCHA's and hCaptcha's
// attribute, so a page that HAS cleared Cloudflare but carries a third-party captcha on a
// login form would be read as an unsolvable challenge and the poll loop would never finish.
const INTERACTIVE_MARKERS = ['cf-turnstile', 'challenges.cloudflare.com/turnstile'] as const;
// `just a moment` was REJECTED as too generic — it matches ordinary copy like "Just a moment,
// loading your cart". The markers below plus the cf-mitigated header identify the real
// interstitial without it.
const CHALLENGE_MARKERS = ['challenge-form', 'challenge-platform', 'cf_chl_opt'] as const;

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/**
 * Classify one page snapshot. Order matters: a blocked page often still carries challenge
 * markup, and an interactive challenge always carries the generic challenge markers too, so
 * the most specific verdict has to win.
 *
 * A bare 403 with no Cloudflare marker is deliberately `clear` — it is somebody else's 403,
 * and treating it as a challenge would make the solve loop spin until its deadline on a page
 * that is never going to change.
 */
export function classify(snap: PageSnapshot): Verdict {
  const html = snap.html.toLowerCase();

  if (BLOCK_MARKERS.some((m) => html.includes(m))) return 'blocked';
  if (INTERACTIVE_MARKERS.some((m) => html.includes(m))) return 'interactive';

  const mitigated = header(snap.headers, 'cf-mitigated');
  if (mitigated !== undefined && mitigated.trim().toLowerCase() === 'challenge') return 'challenged';

  if (CHALLENGE_MARKERS.some((m) => html.includes(m))) return 'challenged';

  return 'clear';
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/detect.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/browser/detect.ts test/unit/detect.test.ts
git commit -m "feat: classify a page snapshot as clear, challenged, interactive or blocked

Order matters — a blocked page still carries challenge markup and an interactive
challenge carries the generic markers too, so the most specific verdict wins. A
bare 403 with no Cloudflare marker stays clear on purpose: it belongs to the
site, and spinning on it would just burn the deadline."
```

---

### Task 4: Job queue

**Files:**
- Create: `src/jobs/queue.ts`
- Test: `test/unit/queue.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type JobState = 'queued' | 'running' | 'done' | 'failed' | 'pending-human'`
  - `type FailureCode = 'challenge-failed' | 'pending-timeout' | 'blocked' | 'http-error' | 'network' | 'cancelled' | 'browser-crashed' | 'disk-full'`
  - `interface Job<T> { id: string; key: string; state: JobState; createdAt: number; result?: T; error?: { code: FailureCode; message: string } }`
  - `class JobQueue<P, R>` with `submit(key: string, payload: P): Job<R>`, `get(id: string): Job<R> | undefined`, `wait(id: string): Promise<Job<R>>`, `readonly busy: number`, `readonly depth: number`

- [ ] **Step 1: Write the failing test**

Create `test/unit/queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { JobQueue } from '../../src/jobs/queue.js';

/** A controllable worker: each call parks until the test resolves it. */
function gate() {
  const opened: Array<(v: string) => void> = [];
  const failed: Array<(e: unknown) => void> = [];
  const run = () =>
    new Promise<string>((resolve, reject) => {
      opened.push(resolve);
      failed.push(reject);
    });
  return { run, opened, failed };
}

const ids = () => {
  let n = 0;
  return () => `job-${++n}`;
};

describe('JobQueue', () => {
  it('runs a submitted job and records the result', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 1000,
      run: async (payload) => `ran:${payload}`,
    });

    const job = q.submit('k1', 'alpha');
    expect(job.id).toBe('job-1');
    // submit() claims the slot synchronously when one is free, so 'running' is the honest
    // reading here. (The plan originally asserted 'queued', which contradicted its own
    // pump() — caught reviewing task 4.)
    expect(job.state).toBe('running');

    const done = await q.wait(job.id);
    expect(done.state).toBe('done');
    expect(done.result).toBe('ran:alpha');
    expect(done.createdAt).toBe(1000);
  });

  it('records a failure code when the worker throws', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: async () => { throw Object.assign(new Error('nope'), { code: 'blocked' }); },
    });

    const done = await q.wait(q.submit('k', 'x').id);
    expect(done.state).toBe('failed');
    expect(done.error).toEqual({ code: 'blocked', message: 'nope' });
  });

  it('defaults an uncoded throw to network', async () => {
    const q = new JobQueue<string, string>({
      concurrency: 1,
      idgen: ids(),
      now: () => 0,
      run: async () => { throw new Error('socket died'); },
    });

    const done = await q.wait(q.submit('k', 'x').id);
    expect(done.error?.code).toBe('network');
    expect(done.error?.message).toBe('socket died');
  });

  it('dedupes an identical key that is still in flight', async () => {
    const g = gate();
    const q = new JobQueue<string, string>({ concurrency: 4, idgen: ids(), now: () => 0, run: g.run });

    const a = q.submit('same', 'x');
    const b = q.submit('same', 'x');
    expect(b.id).toBe(a.id);
    expect(q.depth).toBe(1);

    g.opened[0]!('done');
    await q.wait(a.id);
  });

  it('does not dedupe against a job that already settled', async () => {
    const q = new JobQueue<string, string>({ concurrency: 1, idgen: ids(), now: () => 0, run: async () => 'ok' });

    const a = q.submit('same', 'x');
    await q.wait(a.id);
    const b = q.submit('same', 'x');

    expect(b.id).not.toBe(a.id);
  });

  it('never runs more than `concurrency` jobs at once', async () => {
    const g = gate();
    const q = new JobQueue<string, string>({ concurrency: 2, idgen: ids(), now: () => 0, run: g.run });

    q.submit('a', 'a'); q.submit('b', 'b'); q.submit('c', 'c');
    await Promise.resolve();

    expect(g.opened.length).toBe(2);
    expect(q.busy).toBe(2);

    g.opened[0]!('first');
    await new Promise((r) => setTimeout(r, 0));
    expect(g.opened.length).toBe(3);
  });

  it('returns undefined for an unknown id and rejects a wait on one', async () => {
    const q = new JobQueue<string, string>({ concurrency: 1, idgen: ids(), now: () => 0, run: async () => 'ok' });
    expect(q.get('nope')).toBeUndefined();
    await expect(q.wait('nope')).rejects.toThrow(/unknown job/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/queue.test.ts`
Expected: FAIL — cannot resolve `../../src/jobs/queue.js`

- [ ] **Step 3: Implement `src/jobs/queue.ts`**

```ts
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'pending-human';

export type FailureCode =
  | 'challenge-failed'
  | 'pending-timeout'
  | 'blocked'
  | 'http-error'
  | 'network'
  | 'cancelled'
  | 'browser-crashed'
  | 'disk-full';

export interface JobError {
  code: FailureCode;
  message: string;
}

export interface Job<R> {
  id: string;
  key: string;
  state: JobState;
  createdAt: number;
  result?: R;
  error?: JobError;
}

export interface JobQueueOptions<P, R> {
  concurrency: number;
  run: (payload: P, job: Job<R>) => Promise<R>;
  idgen: () => string;
  now: () => number;
}

const SETTLED: ReadonlySet<JobState> = new Set<JobState>(['done', 'failed']);

/** A thrown value may carry a FailureCode; anything else is a network fault. */
function errorOf(e: unknown): JobError {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  return { code: typeof code === 'string' ? (code as FailureCode) : 'network', message };
}

export class JobQueue<P, R> {
  private readonly jobs = new Map<string, Job<R>>();
  private readonly byKey = new Map<string, string>();
  private readonly payloads = new Map<string, P>();
  private readonly waiters = new Map<string, Array<(j: Job<R>) => void>>();
  private readonly pending: string[] = [];
  private running = 0;

  constructor(private readonly opts: JobQueueOptions<P, R>) {}

  get busy(): number { return this.running; }

  /** Jobs that have not settled — queued plus running. */
  get depth(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (!SETTLED.has(j.state)) n++;
    return n;
  }

  /**
   * Submit work. An identical `key` whose job has not settled returns that same job rather
   * than starting a second one — this is what stops a consumer's retry loop from spawning
   * parallel browsers for one URL.
   */
  submit(key: string, payload: P): Job<R> {
    const existingId = this.byKey.get(key);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (existing && !SETTLED.has(existing.state)) return existing;
      this.byKey.delete(key);
    }

    const job: Job<R> = { id: this.opts.idgen(), key, state: 'queued', createdAt: this.opts.now() };
    this.jobs.set(job.id, job);
    this.byKey.set(key, job.id);
    this.payloads.set(job.id, payload);
    this.pending.push(job.id);
    this.pump();
    return job;
  }

  get(id: string): Job<R> | undefined { return this.jobs.get(id); }

  /** Resolve once the job settles. Rejects for an id this queue never issued. */
  wait(id: string): Promise<Job<R>> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`unknown job: ${id}`));
    if (SETTLED.has(job.state)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  private pump(): void {
    while (this.running < this.opts.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id);
      const payload = this.payloads.get(id);
      if (!job || payload === undefined) continue;

      // Synchronously, in this order: mark running, claim the slot, THEN start the work on a
      // microtask. Deferring the state instead would let a worker that sets job.state in its
      // own prologue (e.g. 'pending-human') have it clobbered a microtask later. Starting the
      // work via Promise.resolve() means a run() that throws SYNCHRONOUSLY lands in .catch
      // rather than escaping pump() and leaking the slot forever.
      job.state = 'running';
      this.running++;
      void Promise.resolve()
        .then(() => this.opts.run(payload, job))
        .then((result) => { job.result = result; job.state = 'done'; })
        .catch((e: unknown) => { job.error = errorOf(e); job.state = 'failed'; })
        .finally(() => {
          this.running--;
          this.payloads.delete(id);
          this.settle(job);
          this.pump();
        });
    }
  }

  private settle(job: Job<R>): void {
    const list = this.waiters.get(job.id);
    this.waiters.delete(job.id);
    for (const resolve of list ?? []) resolve(job);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/queue.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/jobs/queue.ts test/unit/queue.test.ts
git commit -m "feat: bounded job queue with in-flight dedupe

Dedupe is on an unsettled key only, so a retry after a failure genuinely
retries rather than handing back the stale failure. Clock and id generator are
injected so the tests are deterministic."
```

---

### Task 5: `/v1` command dispatch

**Files:**
- Create: `src/api/v1.ts`
- Test: `test/unit/v1.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — the solver is injected
- Produces:
  - `interface SolvedCookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }`
  - `interface Solution { url: string; status: number; headers: Record<string, string>; cookies: SolvedCookie[]; userAgent: string; response: string }`
  - `type Solver = (req: { url: string; session: string; maxTimeout: number; postData?: string }) => Promise<Solution>`
  - `interface V1Deps { solve: Solver; now: () => number; version: string; sessions: Set<string> }`
  - `function handleV1(body: unknown, deps: V1Deps): Promise<{ httpStatus: number; body: unknown }>`

- [ ] **Step 1: Write the failing test**

Create `test/unit/v1.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleV1, type Solution, type V1Deps } from '../../src/api/v1.js';

const solution: Solution = {
  url: 'http://example.test/',
  status: 200,
  headers: { 'content-type': 'text/html' },
  cookies: [{ name: 'cf_clearance', value: 'abc123', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: false }],
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
  response: '<html>ok</html>',
};

const deps = (over: Partial<V1Deps> = {}): V1Deps => ({
  solve: vi.fn(async () => solution),
  now: () => 1_700_000_000_000,
  version: '1.0.0',
  sessions: new Set<string>(),
  ...over,
});

describe('handleV1', () => {
  // The exact payload Allarr's CloudflareCurlHandler sends. If this stops working,
  // the whole increment is pointless.
  it('answers Allarr\'s request.get payload with the two fields it reads', async () => {
    const { httpStatus, body } = await handleV1(
      { cmd: 'request.get', url: 'http://example.test/', maxTimeout: 70000 },
      deps(),
    );

    expect(httpStatus).toBe(200);
    const r = body as any;
    expect(r.status).toBe('ok');
    expect(r.solution.userAgent).toBe(solution.userAgent);
    expect(r.solution.cookies.find((c: any) => c.name === 'cf_clearance').value).toBe('abc123');
  });

  it('emits every field FlareSolverr does', async () => {
    const { body } = await handleV1({ cmd: 'request.get', url: 'http://example.test/' }, deps());
    const r = body as any;

    expect(Object.keys(r).sort()).toEqual(
      ['endTimestamp', 'message', 'solution', 'startTimestamp', 'status', 'version'].sort(),
    );
    expect(Object.keys(r.solution).sort()).toEqual(
      ['cookies', 'headers', 'response', 'status', 'url', 'userAgent'].sort(),
    );
  });

  it('defaults maxTimeout and session when absent', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.get', url: 'http://example.test/' }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith({ url: 'http://example.test/', session: 'example.test', maxTimeout: 60000, postData: undefined });
  });

  it('passes an explicit session through', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.get', url: 'http://example.test/', session: 'vimm' }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith(expect.objectContaining({ session: 'vimm' }));
  });

  it('forwards postData for request.post', async () => {
    const solve = vi.fn(async () => solution);
    await handleV1({ cmd: 'request.post', url: 'http://example.test/', postData: 'a=1' }, deps({ solve }));

    expect(solve).toHaveBeenCalledWith(expect.objectContaining({ postData: 'a=1' }));
  });

  it('creates, lists and destroys sessions', async () => {
    const d = deps();
    expect((await handleV1({ cmd: 'sessions.create', session: 'vimm' }, d)).httpStatus).toBe(200);
    expect(d.sessions.has('vimm')).toBe(true);

    const listed = (await handleV1({ cmd: 'sessions.list' }, d)).body as any;
    expect(listed.sessions).toEqual(['vimm']);

    await handleV1({ cmd: 'sessions.destroy', session: 'vimm' }, d);
    expect(d.sessions.has('vimm')).toBe(false);
  });

  // Allarr treats any non-2xx as "FlareSolverr is unavailable" and degrades, which is
  // exactly what we want for a request we cannot serve.
  it('returns 500 and the error shape for an unknown command', async () => {
    const { httpStatus, body } = await handleV1({ cmd: 'nonsense' }, deps());
    expect(httpStatus).toBe(500);
    expect((body as any).status).toBe('error');
    expect((body as any).message).toMatch(/nonsense/);
    expect((body as any).solution).toBeUndefined();
  });

  it('returns 500 for a missing url', async () => {
    const { httpStatus, body } = await handleV1({ cmd: 'request.get' }, deps());
    expect(httpStatus).toBe(500);
    expect((body as any).message).toMatch(/url/i);
  });

  it('returns 500 for a non-object body', async () => {
    expect((await handleV1('nope', deps())).httpStatus).toBe(500);
    expect((await handleV1(null, deps())).httpStatus).toBe(500);
  });

  it('reports a solver failure as the error shape, not a crash', async () => {
    const solve = vi.fn(async () => { throw new Error('challenge never cleared'); });
    const { httpStatus, body } = await handleV1({ cmd: 'request.get', url: 'http://example.test/' }, deps({ solve }));

    expect(httpStatus).toBe(500);
    expect((body as any).message).toMatch(/challenge never cleared/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/v1.test.ts`
Expected: FAIL — cannot resolve `../../src/api/v1.js`

- [ ] **Step 3: Implement `src/api/v1.ts`**

```ts
export interface SolvedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface Solution {
  url: string;
  status: number;
  headers: Record<string, string>;
  cookies: SolvedCookie[];
  userAgent: string;
  response: string;
}

export interface SolveRequest {
  url: string;
  session: string;
  maxTimeout: number;
  postData?: string;
}

export type Solver = (req: SolveRequest) => Promise<Solution>;

export interface V1Deps {
  solve: Solver;
  now: () => number;
  version: string;
  /** Session names created via sessions.create. Partitions are created lazily regardless. */
  sessions: Set<string>;
}

const DEFAULT_MAX_TIMEOUT = 60_000;

/** Session name derived from a URL when the caller supplies none. */
function sessionFor(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'default';
  }
}

function ok(deps: V1Deps, startTimestamp: number, extra: Record<string, unknown>) {
  return {
    httpStatus: 200,
    body: {
      status: 'ok',
      message: '',
      startTimestamp,
      endTimestamp: deps.now(),
      version: deps.version,
      ...extra,
    },
  };
}

function fail(deps: V1Deps, startTimestamp: number, message: string) {
  return {
    httpStatus: 500,
    body: {
      status: 'error',
      message,
      startTimestamp,
      endTimestamp: deps.now(),
      version: deps.version,
    },
  };
}

/**
 * FlareSolverr's /v1 protocol. The shape here is not ours to design — Allarr already speaks
 * it, and matching it exactly is what lets this ship without touching Allarr.
 *
 * Allarr reads precisely two things: `solution.userAgent`, and the `cf_clearance` entry in
 * `solution.cookies`. Everything else exists for compatibility with other callers.
 */
export async function handleV1(body: unknown, deps: V1Deps): Promise<{ httpStatus: number; body: unknown }> {
  const startTimestamp = deps.now();

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(deps, startTimestamp, 'request body must be a JSON object');
  }

  const req = body as Record<string, unknown>;
  const cmd = typeof req.cmd === 'string' ? req.cmd : '';

  switch (cmd) {
    case 'sessions.create': {
      const session = typeof req.session === 'string' && req.session ? req.session : 'default';
      deps.sessions.add(session);
      return ok(deps, startTimestamp, { session });
    }
    case 'sessions.list':
      return ok(deps, startTimestamp, { sessions: [...deps.sessions] });
    case 'sessions.destroy': {
      const session = typeof req.session === 'string' ? req.session : '';
      deps.sessions.delete(session);
      return ok(deps, startTimestamp, {});
    }
    case 'request.get':
    case 'request.post': {
      const url = typeof req.url === 'string' ? req.url : '';
      if (!url) return fail(deps, startTimestamp, 'url is required for ' + cmd);

      const maxTimeout =
        typeof req.maxTimeout === 'number' && Number.isFinite(req.maxTimeout) && req.maxTimeout > 0
          ? req.maxTimeout
          : DEFAULT_MAX_TIMEOUT;
      const session = typeof req.session === 'string' && req.session ? req.session : sessionFor(url);
      const postData = cmd === 'request.post' && typeof req.postData === 'string' ? req.postData : undefined;

      try {
        const solution = await deps.solve({ url, session, maxTimeout, postData });
        return ok(deps, startTimestamp, { solution });
      } catch (e: unknown) {
        return fail(deps, startTimestamp, e instanceof Error ? e.message : String(e));
      }
    }
    default:
      return fail(deps, startTimestamp, `unknown command: ${cmd || '(none)'}`);
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/v1.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/api/v1.ts test/unit/v1.test.ts
git commit -m "feat: FlareSolverr /v1 command dispatch

The response shape is FlareSolverr's, matched field for field. One test pins
the exact payload Allarr's CloudflareCurlHandler sends and asserts the two
fields it actually reads. An unserviceable request answers 500 with the error
shape, which is the signal Allarr already degrades on."
```

---

### Task 6: HTTP server, auth gate and port-collision diagnosis

**Files:**
- Create: `src/api/server.ts`, `src/log.ts`
- Test: `test/unit/server.test.ts`

**Interfaces:**
- Consumes: `GatehouseConfig`, `isLoopback` (Task 1); `handleV1`, `V1Deps` (Task 5)
- Produces:
  - `interface ServerHandle { port: number; close(): Promise<void> }`
  - `function startServer(cfg: GatehouseConfig, deps: V1Deps, health: () => object): Promise<ServerHandle>`
  - `class PortInUseError extends Error`
  - `interface Logger { info(msg: string, meta?: object): void; warn(msg: string, meta?: object): void; error(msg: string, meta?: object): void }`
  - `const log: Logger`

- [ ] **Step 1: Write the failing test**

Create `test/unit/server.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer, PortInUseError, type ServerHandle } from '../../src/api/server.js';
import type { V1Deps, Solution } from '../../src/api/v1.js';
import { loadConfig } from '../../src/config.js';

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

  it('returns the error shape, not a crash, for malformed JSON', async () => {
    h = await startServer(loadConfig({ GATEHOUSE_PORT: '0' }), deps(), health);
    const res = await fetch(`http://127.0.0.1:${h.port}/v1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    expect(res.status).toBe(500);
    expect((await res.json() as any).status).toBe('error');
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
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/server.test.ts`
Expected: FAIL — cannot resolve `../../src/api/server.js`

- [ ] **Step 3: Implement `src/log.ts`**

```ts
export interface Logger {
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

/**
 * Every line goes through `redact` before it is written. Increment 1 has nothing to redact;
 * increment 4 registers configured credential values here, and the redaction property test
 * asserts none of them ever reach a log line.
 */
const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value.trim()) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

function emit(level: 'info' | 'warn' | 'error', msg: string, meta?: object): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  // eslint-disable-next-line no-console
  console[level === 'info' ? 'log' : level](`gatehouse: ${redact(line)}`);
}

export const log: Logger = {
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
};
```

- [ ] **Step 4: Implement `src/api/server.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { isLoopback, type GatehouseConfig } from '../config.js';
import { handleV1, type V1Deps } from './v1.js';
import { log } from '../log.js';

export class PortInUseError extends Error {}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Constant-time compare that does not leak length through an early return. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, cfg: GatehouseConfig): boolean {
  // A loopback bind takes no auth: Allarr's FlareSolverr client sends no Authorization
  // header, and requiring one would break drop-in compatibility on day one.
  if (isLoopback(cfg.bind)) return true;
  if (cfg.token === null) return false;

  const header = req.headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return tokenMatches(header.slice(prefix.length), cfg.token);
}

export async function startServer(cfg: GatehouseConfig, deps: V1Deps, health: () => object): Promise<ServerHandle> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req, cfg)) { send(res, 401, { status: 'error', message: 'unauthorized' }); return; }

        const path = (req.url ?? '/').split('?')[0] ?? '/';

        if (path === '/gh/health') {
          if (req.method !== 'GET') { send(res, 405, { status: 'error', message: 'GET only' }); return; }
          send(res, 200, health());
          return;
        }

        if (path === '/v1') {
          if (req.method !== 'POST') { send(res, 405, { status: 'error', message: 'POST only' }); return; }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Deliberately the FlareSolverr error shape rather than a 400: any non-2xx is the
            // signal a FlareSolverr client already degrades on.
            send(res, 500, { status: 'error', message: 'request body was not valid JSON', startTimestamp: deps.now(), endTimestamp: deps.now(), version: deps.version });
            return;
          }
          const { httpStatus, body } = await handleV1(parsed, deps);
          send(res, httpStatus, body);
          return;
        }

        send(res, 404, { status: 'error', message: `no such path: ${path}` });
      } catch (e: unknown) {
        log.error('request failed', { message: e instanceof Error ? e.message : String(e) });
        if (!res.headersSent) send(res, 500, { status: 'error', message: 'internal error' });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new PortInUseError(
          `port ${cfg.port} on ${cfg.bind} is already in use. Port 8191 is FlareSolverr's own — ` +
            `if a real FlareSolverr is running, stop it or set GATEHOUSE_PORT to run both. ` +
            `Refusing to fall back to another port: the two are indistinguishable on the wire, ` +
            `so a silent move would leave it unclear which one your client is talking to.`,
        ));
        return;
      }
      reject(err);
    };
    const onListening = () => { server.removeListener('error', onError); resolve(); };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(cfg.port, cfg.bind);
  });

  const port = (server.address() as AddressInfo).port;
  log.info(`listening on http://${cfg.bind}:${port}`);

  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/server.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add src/api/server.ts src/log.ts test/unit/server.test.ts
git commit -m "feat: HTTP server with a loopback-conditional auth gate

Loopback takes no token, because Allarr sends no Authorization header. A
non-loopback bind requires one and compares it in constant time. A taken port
fails startup naming the collision rather than moving to another port — 8191 is
FlareSolverr's own and the two are indistinguishable on the wire, so a silent
move would leave it unclear which one the client reached."
```

---

### Task 7: Electron shell, browser pool and the real solver

**Files:**
- Create: `src/browser/pool.ts`, `src/browser/solve.ts`, `src/main.ts`, `test/integration/harness.ts`
- Test: `test/integration/solve.test.ts`

**Interfaces:**
- Consumes: `classify`, `PageSnapshot` (Task 3); `JobQueue`, `FailureCode` (Task 4); `Solution`, `SolveRequest`, `Solver`, `V1Deps` (Task 5); `startServer` (Task 6); `loadConfig` (Task 1)
- Produces:
  - `class BrowserPool` with `acquire(session: string): Promise<Electron.BrowserWindow>`, `release(win: Electron.BrowserWindow): void`, `readonly busy: number`, `readonly total: number`, `destroy(): void`
  - `function makeSolver(pool: BrowserPool): Solver`
  - `interface Harness { url: string; stop(): Promise<void> }`
  - `function startGatehouse(env?: Record<string, string>): Promise<Harness>`

- [ ] **Step 1: Implement `src/browser/pool.ts`**

```ts
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
```

- [ ] **Step 2: Implement `src/browser/solve.ts`**

```ts
import type { BrowserPool } from './pool.js';
import { classify, type PageSnapshot } from './detect.js';
import type { Solution, Solver, SolveRequest, SolvedCookie } from '../api/v1.js';
import type { FailureCode } from '../jobs/queue.js';
import { log } from '../log.js';

const POLL_INTERVAL_MS = 400;

/** A fixed literal. Page content is never interpolated into this. */
const GRAB_HTML = 'document.documentElement.outerHTML';

function coded(code: FailureCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeSolver(pool: BrowserPool): Solver {
  return async (req: SolveRequest): Promise<Solution> => {
    const win = await pool.acquire(req.session);
    const wc = win.webContents;
    const ses = wc.session;

    // Main-frame response status and headers, captured as they arrive.
    let status = 0;
    let headers: Record<string, string> = {};
    const onHeaders = (details: Electron.OnHeadersReceivedListenerDetails, cb: (r: Electron.HeadersReceivedResponse) => void) => {
      if (details.resourceType === 'mainFrame') {
        status = details.statusCode;
        headers = Object.fromEntries(
          Object.entries(details.responseHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]),
        );
      }
      cb({});
    };
    ses.webRequest.onHeadersReceived(onHeaders);

    const deadline = Date.now() + req.maxTimeout;

    try {
      if (req.postData !== undefined) {
        await wc.loadURL(req.url, {
          postData: [{ type: 'rawData', bytes: Buffer.from(req.postData, 'utf8') }],
          extraHeaders: 'Content-Type: application/x-www-form-urlencoded',
        });
      } else {
        await wc.loadURL(req.url);
      }

      let verdict = 'challenged' as ReturnType<typeof classify>;
      let html = '';

      while (Date.now() < deadline) {
        html = (await wc.executeJavaScript(GRAB_HTML, true)) as string;
        const snap: PageSnapshot = { status, headers, html };
        verdict = classify(snap);

        if (verdict === 'clear') break;
        if (verdict === 'blocked') {
          throw coded('blocked', `host returned a hard block for ${req.url}`);
        }
        if (verdict === 'interactive') {
          // SEAM FOR INCREMENT 3: this is where the job becomes `pending-human` and the
          // window is shown. Until then an interactive challenge is a clean failure.
          throw coded('challenge-failed', `${req.url} needs an interactive challenge solved; not supported yet`);
        }
        await sleep(POLL_INTERVAL_MS);
      }

      if (verdict !== 'clear') {
        throw coded('challenge-failed', `challenge did not clear within ${req.maxTimeout}ms for ${req.url}`);
      }

      const finalUrl = wc.getURL();
      const raw = await ses.cookies.get({ url: finalUrl });
      const cookies: SolvedCookie[] = raw.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        expires: c.expirationDate ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
      }));

      log.info('solved', { url: req.url, session: req.session, status, cookies: cookies.length });

      return { url: finalUrl, status, headers, cookies, userAgent: wc.getUserAgent(), response: html };
    } catch (e: unknown) {
      if (wc.isDestroyed()) throw coded('browser-crashed', 'the browser window died mid-solve');
      throw e;
    } finally {
      ses.webRequest.onHeadersReceived(null);
      pool.release(win);
    }
  };
}
```

- [ ] **Step 3: Implement `src/main.ts`**

```ts
import { app } from 'electron';
import { loadConfig } from './config.js';
import { BrowserPool } from './browser/pool.js';
import { makeSolver } from './browser/solve.js';
import { JobQueue } from './jobs/queue.js';
import { startServer } from './api/server.js';
import type { Solution, SolveRequest, V1Deps } from './api/v1.js';
import { log } from './log.js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

// A headless solver has no dock/taskbar presence and must not quit when its last hidden
// window closes.
app.on('window-all-closed', () => { /* keep running */ });

app.whenReady().then(async () => {
  const cfg = loadConfig(process.env);
  const pool = new BrowserPool();
  const solve = makeSolver(pool);

  const queue = new JobQueue<SolveRequest, Solution>({
    concurrency: cfg.concurrency,
    idgen: () => randomUUID(),
    now: () => Date.now(),
    run: (payload) => solve(payload),
  });

  const deps: V1Deps = {
    // Every /v1 solve goes through the queue, so concurrency and dedupe apply to it too.
    solve: async (req) => {
      const job = queue.submit(`${req.session}\u0000${req.url}\u0000${req.postData ?? ''}`, req);
      const settled = await queue.wait(job.id);
      if (settled.state === 'done' && settled.result) return settled.result;
      throw Object.assign(new Error(settled.error?.message ?? 'solve failed'), { code: settled.error?.code });
    },
    now: () => Date.now(),
    version,
    sessions: new Set<string>(),
  };

  const health = () => ({
    version,
    browsers: { busy: pool.busy, total: pool.total },
    queue: { depth: queue.depth },
  });

  try {
    const server = await startServer(cfg, deps, health);
    // The integration harness waits for this exact line.
    process.stdout.write(`GATEHOUSE_READY http://${cfg.bind}:${server.port}\n`);
    app.on('before-quit', () => { pool.destroy(); void server.close(); });
  } catch (e: unknown) {
    log.error(e instanceof Error ? e.message : String(e));
    app.exit(1);
  }
});
```

- [ ] **Step 4: Implement `test/integration/harness.ts`**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface Harness {
  url: string;
  stop(): Promise<void>;
}

/**
 * Spawn the real built app and wait for its ready line. Tests then drive it over HTTP,
 * exactly the way Allarr does — no Playwright, no Electron test API, no in-process shortcut
 * that could pass while the shipped binary is broken.
 */
export function startGatehouse(env: Record<string, string> = {}): Promise<Harness> {
  const electron = require('electron') as unknown as string;

  return new Promise((resolvePromise, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      electron,
      [repoRoot],
      { env: { ...process.env, GATEHOUSE_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;

    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`gatehouse did not report ready within 30s. stdout:\n${out}`));
    }, 30_000);

    const stop = () =>
      new Promise<void>((r) => {
        child.once('exit', () => r());
        child.kill();
      });

    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      const m = /GATEHOUSE_READY (\S+)/.exec(out);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise({ url: m[1]!, stop });
      }
    });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`gatehouse exited with ${code} before reporting ready. output:\n${out}`));
    });
  });
}
```

- [ ] **Step 5: Write the integration test**

Create `test/integration/solve.test.ts`:

```ts
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

  it('clears the JS challenge and returns what Allarr reads', async () => {
    fx = await startCloudflareFixture();

    // The exact payload CloudflareCurlHandler.MintCookieAsync sends.
    const { status, json } = await v1({ cmd: 'request.get', url: fx.url + '/', maxTimeout: 70000 });

    expect(status).toBe(200);
    expect(json.status).toBe('ok');

    // The two fields Allarr actually reads.
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
```

- [ ] **Step 6: Build, then run the integration test**

```bash
npx tsc
npx vitest run test/integration/solve.test.ts
```

Expected: PASS, 4 tests. The first run downloads nothing extra; Electron is already installed.

If it fails with a window/display error, note that Electron needs a desktop session — on Windows this is fine; on a headless Linux CI leg it needs `xvfb-run`.

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — 7 + 6 + 9 + 7 + 10 + 8 + 4 = 51 tests

- [ ] **Step 8: Commit**

```bash
git add src/browser/pool.ts src/browser/solve.ts src/main.ts test/integration/harness.ts test/integration/solve.test.ts
git commit -m "feat: browser pool and the real solve loop

Hidden BrowserWindows, one persistent partition per session name, so a cleared
host stays cleared. The solve loop polls snapshots through the classifier
rather than sleeping a fixed interval. An interactive challenge fails cleanly
at a marked seam that increment 3 turns into pending-human.

The integration test spawns the real built app and drives it over HTTP, the
same way Allarr will — no in-process shortcut that could pass while the shipped
binary is broken."
```

---

### Task 8: Acceptance — prove Allarr's own client works, and document it

**Files:**
- Create: `README.md`, `test/integration/allarr-compat.test.ts`
- Modify: `package.json` (add `test:unit` and `test:integration` scripts)

**Interfaces:**
- Consumes: `startGatehouse` (Task 7), `startCloudflareFixture` (Task 2)
- Produces: nothing further

- [ ] **Step 1: Write the wire-compatibility test**

Create `test/integration/allarr-compat.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startGatehouse, type Harness } from './harness.js';
import { startCloudflareFixture, type Fixture } from '../fixture/cloudflare.js';

let gh: Harness;
let fx: Fixture;

beforeAll(async () => {
  gh = await startGatehouse();
  fx = await startCloudflareFixture();
}, 60_000);
afterAll(async () => { await gh?.stop(); await fx?.close(); });

/**
 * A byte-level replay of what Allarr.Plugin/Transport/CloudflareCurlHandler.cs does in
 * MintCookieAsync. If this test goes red, increment 1's entire premise is void, however
 * green the rest of the suite is.
 */
describe('Allarr wire compatibility', () => {
  it('answers the exact serialized payload Allarr posts', async () => {
    // JsonSerializer.Serialize(new { cmd, url, maxTimeout }) — property order and all.
    const payload = `{"cmd":"request.get","url":"${fx.url}/","maxTimeout":70000}`;

    const res = await fetch(`${gh.url}/v1`, {
      method: 'POST',
      // StringContent(payload, Encoding.UTF8, "application/json"), and NO Authorization header.
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: payload,
    });

    // resp.IsSuccessStatusCode
    expect(res.ok).toBe(true);

    const doc = (await res.json()) as any;

    // doc.RootElement.GetProperty("solution") — must not throw.
    expect(doc.solution).toBeDefined();

    // solution.TryGetProperty("userAgent") -> non-empty
    expect(typeof doc.solution.userAgent).toBe('string');
    expect(doc.solution.userAgent.length).toBeGreaterThan(0);

    // solution.TryGetProperty("cookies") must be an array carrying cf_clearance with a value.
    expect(Array.isArray(doc.solution.cookies)).toBe(true);
    const cf = doc.solution.cookies.find((c: any) => c.name === 'cf_clearance');
    expect(cf).toBeDefined();
    expect(typeof cf.value).toBe('string');
    expect(cf.value.length).toBeGreaterThan(0);
  }, 60_000);

  it('answers a failure with a non-2xx, which is what Allarr degrades on', async () => {
    const res = await fetch(`${gh.url}/v1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"cmd":"request.get","url":"http://127.0.0.1:1/","maxTimeout":4000}',
    });

    expect(res.ok).toBe(false);
    expect((await res.json() as any).status).toBe('error');
  }, 60_000);
});
```

- [ ] **Step 2: Run it**

```bash
npx tsc
npx vitest run test/integration/allarr-compat.test.ts
```

Expected: PASS, 2 tests

- [ ] **Step 3: Add the split test scripts**

```bash
npm pkg set scripts.test:unit="vitest run test/unit"
npm pkg set scripts.test:integration="tsc && vitest run test/integration"
npm pkg set scripts.test="tsc && vitest run"
```

- [ ] **Step 4: Write `README.md`**

```markdown
# Gatehouse

A browser-backed solver-proxy. It drives a real Chromium through Cloudflare's
non-interactive challenge, holds persistent per-site sessions, and answers
FlareSolverr's `/v1` protocol so existing clients need no changes.

It is **not** a CAPTCHA bypass. The non-interactive JS challenge clears simply by
being a real browser. An interactive challenge is refused in this increment, and
in a later one is handed to a person to solve once.

See [the design](docs/superpowers/specs/2026-08-22-gatehouse-design.md).

## Run

```
npm install
npm run build
npm start
```

Listens on `http://127.0.0.1:8191` by default — FlareSolverr's port, so an
existing `FlareSolverrUrl` setting needs no edit.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `GATEHOUSE_PORT` | `8191` | Listen port. `0` picks a free one. |
| `GATEHOUSE_BIND` | `127.0.0.1` | Bind address. Non-loopback requires a token. |
| `GATEHOUSE_TOKEN` | *(none)* | Bearer token. Mandatory for a non-loopback bind. |
| `GATEHOUSE_CONCURRENCY` | `2` | Simultaneous browser windows. |
| `GATEHOUSE_SOLVE_TIMEOUT_MS` | `70000` | Deadline for one solve. |

A loopback bind takes no auth, because FlareSolverr clients send no
`Authorization` header. Binding anywhere else without `GATEHOUSE_TOKEN` is
refused at startup rather than silently exposing a browser driver.

Port 8191 already taken? Startup fails saying so rather than moving to another
port — the two are indistinguishable on the wire, so a silent move would leave
it unclear which one your client reached.

## Test

```
npm run test:unit          # fast, no Electron
npm run test:integration   # spawns the real app
npm test                   # everything
```

Tests run against a fake Cloudflare in `test/fixture/`, never against a live
site. The fixture's own first test asserts a plain `fetch` cannot get through
it — if that ever passes, the fixture is simulating nothing and every test above
it is worthless.
```

- [ ] **Step 5: Run the full suite one last time**

Run: `npm test`
Expected: PASS, 53 tests

- [ ] **Step 6: Commit**

```bash
git add README.md test/integration/allarr-compat.test.ts package.json
git commit -m "test: pin Allarr's exact wire contract, and document the app

A byte-level replay of what CloudflareCurlHandler.MintCookieAsync posts, and
assertions on precisely the two fields it reads back. If this goes red the
increment's premise is void however green the rest of the suite is."
```

- [ ] **Step 7: Live verification (manual — requires a human)**

This is the increment's real acceptance, and it cannot be automated.

1. Stop any running FlareSolverr.
2. `npm run build && npm start` — confirm `GATEHOUSE_READY http://127.0.0.1:8191`.
3. Confirm the test rig's `Plugins.allarr.GameSource.FlareSolverrUrl` is `http://localhost:8191` (its default) — no edit needed.
4. Restart the EBS test rig at `C:\Users\cubma\ebs-run\out`.
5. Exercise the PC-game feed and watch Gatehouse's console for a `solved` line and Allarr's log for `cleared Cloudflare for {Host} via FlareSolverr`.
6. Record the result — including which host was fetched and whether the feed returned items — in the task report.

**Do not mark increment 1 done on a green suite alone.** The fixture proves the mechanism; only this step proves the premise.

---

## Self-Review

**Spec coverage.** Every increment-1 row in the spec maps to a task: Electron shell (7), hidden window pool (7), job queue (4), `/v1` (5), fake-Cloudflare rig (2). Supporting spec requirements also covered: loopback/token rule (1, 6), port-collision diagnosis (6), challenge classification incl. the blocked/no-retry rule (3), untrusted-renderer handling (7 — `GRAB_HTML` is a fixed literal, `nodeIntegration: false`, `sandbox: true`), failure taxonomy (4), fixture teeth (2), `pending-human` seam marked for increment 3 (7).

Deliberately **not** in this plan, per the spec: `/gh/fetch`, the Range file server, window surfacing, login recipes, `safeStorage`. `src/log.ts` ships a `registerSecret`/`redact` hook with nothing registered, so increment 4's redaction property test has a seam to attach to rather than needing a rewrite.

**Type consistency.** `Solution`, `SolveRequest`, `Solver`, `V1Deps` are defined once in `src/api/v1.ts` and imported by `solve.ts`, `server.ts` and `main.ts`. `FailureCode` is defined once in `src/jobs/queue.ts` and used by `solve.ts` via `coded()`. `PageSnapshot`/`Verdict` are defined once in `detect.ts`. `GatehouseConfig`/`isLoopback` once in `config.ts`. No name drifts between tasks.

**One issue found and fixed inline.** The first draft of `BrowserPool.release` recovered a window's session name by substring-matching its storage path, which silently confuses `vimm` with `vimm2`. Replaced with a `WeakMap<BrowserWindow, string>` recording the name we chose at `acquire` time — authoritative rather than inferred. The `acquire` path also now drains destroyed windows from the free list in a loop instead of checking only the first one.

**Known limitation, stated rather than hidden.** Integration tests need a desktop session, so a headless Linux CI leg would need `xvfb-run`. Increment 1 is Windows-first and this is not solved here.
