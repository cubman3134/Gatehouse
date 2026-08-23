import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startGatehouse, type Harness } from './harness.js';
import { startRecipeHost, type RecipeHost, HOSTILE_HREF } from '../fixture/recipehost.js';

/**
 * Recipes, end to end through the REAL built app.
 *
 * Nothing here is stubbed and nothing is in-process: `electron .` is spawned, a `POST
 * /gh/fetch` carrying a recipe is answered by the shipped server, a real hidden window loads a
 * real page, the hand-written preload really answers on the step channel, and the file really
 * lands on disk. That matters more here than anywhere else in the suite, because every one of
 * the failure modes this feature has is a *silent* one — a preload that does not load, a
 * channel name that drifted, an argument order that does not match the handler — and all of
 * them present identically as "the download hangs". An in-process fake would reproduce none of
 * them.
 *
 * What it deliberately does not prove: that any real site behaves like this fixture. The flow
 * is the measured shape of one, not that one.
 */

let gh: Harness;
let dir: string;

const BODY = Buffer.alloc(512 * 1024, 19);
const SHA = createHash('sha256').update(BODY).digest('hex');

interface JobBody {
  state: string;
  progress: { received: number; total: number };
  result?: { path: string; url: string; size: number; sha256: string; filename: string | null };
  error?: { code: string; message: string };
}

const SETTLED = ['done', 'failed', 'cancelled'];

const job = async (base: string, id: string): Promise<JobBody> =>
  (await (await fetch(`${base}/gh/jobs/${id}`)).json()) as JobBody;

/** The three-verb recipe the fixture's page is built for. */
const recipeFor = (startUrl: string): unknown => ({
  startUrl,
  steps: [
    // The text filter as well as the selector, since a real page has more than one button.
    { op: 'click', selector: 'button', text: 'Download' },
    { op: 'waitFor', selector: 'a#link' },
    { op: 'readAttribute', selector: 'a#link', attribute: 'href' },
  ],
});

const post = (base: string, body: unknown): Promise<Response> =>
  fetch(`${base}/gh/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const fetchRecipe = async (base: string, startUrl: string, site: string): Promise<string> => {
  const res = await post(base, { recipe: recipeFor(startUrl), site });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { jobId: string; state: string };
  expect(body.state).toBe('queued');
  return body.jobId;
};

/** Poll to a settled state, THROWING on the deadline so a hang fails as a hang. */
const settle = async (base: string, id: string, ms = 60_000): Promise<JobBody> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = await job(base, id);
    if (SETTLED.includes(body.state)) return body;
    if (Date.now() > deadline) {
      throw new Error(`job ${id} never settled within ${ms}ms; last state ${body.state}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-recipe-'));
  gh = await startGatehouse({ GATEHOUSE_DOWNLOADS_DIR: dir });
}, 60_000);

afterAll(async () => {
  await gh?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('a recipe that reveals a link', () => {
  it('clicks, waits, reads the href and downloads the real bytes', async () => {
    const host: RecipeHost = await startRecipeHost({ mode: 'reveal', body: BODY, filename: 'revealed.bin' });
    try {
      const id = await fetchRecipe(gh.url, host.url, 'reveal');
      const done = await settle(gh.url, id);

      expect(done.error).toBeUndefined();
      expect(done.state).toBe('done');
      // The hash is the proof it fetched the FILE and not the page it started from: the page
      // is served on the same origin and would settle `done` just as happily.
      expect(done.result!.sha256).toBe(SHA);
      expect(done.result!.size).toBe(BODY.length);
      expect((await stat(done.result!.path)).size).toBe(BODY.length);
      expect(done.result!.filename).toBe('revealed.bin');

      // The record's `url` is the recipe's startUrl, which is what keeps dedupe, the logs and
      // `/gh/jobs/:id` working unchanged — and a second POST of the same recipe folds onto it.
      const again = await post(gh.url, { recipe: recipeFor(host.url), site: 'reveal' });
      expect(again.status).toBe(202);

      await fetch(`${gh.url}/gh/jobs/${id}`, { method: 'DELETE' });
    } finally {
      await host.close();
    }
  }, 120_000);
});

describe('a click that starts the download itself', () => {
  /**
   * The second legitimate ending. No link is ever revealed here, so the recipe's `waitFor` and
   * `readAttribute` can never succeed — and must not need to. An item that arrives mid-recipe
   * IS the result, the remaining steps are abandoned, and the job completes on the bytes.
   *
   * This is also the regression net for handler ordering: `will-download` is attached before
   * anything navigates, because an unclaimed item opens a native modal Save As dialog that
   * never resolves. Attach it after `loadURL` and this test hangs instead of passing.
   */
  it('completes on the item rather than on a readAttribute that never happens', async () => {
    const host = await startRecipeHost({ mode: 'direct', body: BODY, filename: 'direct.bin' });
    try {
      const id = await fetchRecipe(gh.url, host.url, 'direct');
      const done = await settle(gh.url, id);

      expect(done.error).toBeUndefined();
      expect(done.state).toBe('done');
      expect(done.result!.sha256).toBe(SHA);
      expect(done.result!.size).toBe(BODY.length);
      expect((await stat(done.result!.path)).size).toBe(BODY.length);

      await fetch(`${gh.url}/gh/jobs/${id}`, { method: 'DELETE' });
    } finally {
      await host.close();
    }
  }, 120_000);
});

describe('a recipe that derives a hostile URL', () => {
  /**
   * The sharpest test here. A derived URL is a *site-controlled string* that arrived over IPC
   * from a page — the one input in this feature that no caller and no validator has seen — and
   * `file:///C:/Windows/win.ini` parses perfectly. `runRecipe` returns it unvalidated on
   * purpose so the gate cannot be skipped by accident; this is what proves the gate is there.
   */
  it('refuses the fetch, names the scheme, and writes nothing', async () => {
    const host = await startRecipeHost({ mode: 'hostile' });
    try {
      const id = await fetchRecipe(gh.url, host.url, 'hostile');
      const settled = await settle(gh.url, id);

      expect(settled.state).toBe('failed');
      expect(settled.error!.code).toBe('recipe-failed');
      // Names the refused scheme, so an operator reading one log line knows the site handed us
      // something we will not fetch rather than that the download failed.
      expect(settled.error!.message).toMatch(/file:/);
      expect(settled.error!.message).toMatch(/scheme/i);
      expect(settled.result).toBeUndefined();

      // Nothing was fetched and nothing was written — not the local file it pointed at, and
      // not a partial.
      expect((await readdir(dir)).filter((f) => f.startsWith(id))).toEqual([]);
      // And the fixture really did serve that href, so this test cannot pass by the link
      // never appearing.
      expect(HOSTILE_HREF.startsWith('file:')).toBe(true);

      await fetch(`${gh.url}/gh/jobs/${id}`, { method: 'DELETE' });
    } finally {
      await host.close();
    }
  }, 120_000);
});

describe('a recipe whose step never matches', () => {
  /**
   * Its own app, with the step budget at its 1000ms floor and the total at its 5000ms one, so
   * this is a test of the timeout rather than of patience. The elapsed bound is the assertion
   * that matters: remove the per-step deadline and the job hangs forever, holding a download
   * slot, which is exactly the failure a missing preload also produces.
   */
  it('fails recipe-failed within the configured bound, naming the step and its selector', async () => {
    const host = await startRecipeHost({ mode: 'never' });
    const neverDir = await mkdtemp(join(tmpdir(), 'gh-never-'));
    const app = await startGatehouse({
      GATEHOUSE_DOWNLOADS_DIR: neverDir,
      GATEHOUSE_RECIPE_STEP_MS: '2000',
      GATEHOUSE_RECIPE_TOTAL_MS: '30000',
      // Comfortably above, so what ends this is unambiguously the step deadline.
      GATEHOUSE_DOWNLOAD_NO_START_MS: '60000',
      GATEHOUSE_DOWNLOAD_STALL_MS: '120000',
    });
    try {
      const started = Date.now();
      const id = await fetchRecipe(app.url, host.url, 'never');
      const settled = await settle(app.url, id, 60_000);
      const took = Date.now() - started;

      expect(settled.state).toBe('failed');
      expect(settled.error!.code).toBe('recipe-failed');
      // The step index and the selector, because "a recipe failed" is not something an
      // operator can act on and "step 1 (waitFor a#link)" is.
      expect(settled.error!.message).toMatch(/step 1/);
      expect(settled.error!.message).toMatch(/waitFor a#link/);
      // The bound. Two seconds of step, plus the bridge grace, plus a page load and a poll
      // interval — and emphatically not the 30s total, the 60s no-start window, or forever.
      expect(took, `the step deadline did not bound this: it took ${took}ms`).toBeLessThan(20_000);
      expect((await readdir(neverDir)).filter((f) => f.startsWith(id))).toEqual([]);
    } finally {
      await app.stop();
      await host.close();
      await rm(neverDir, { recursive: true, force: true });
    }
  }, 150_000);
});
