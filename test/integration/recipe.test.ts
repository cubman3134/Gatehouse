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

/**
 * Poll to a settled state under a deadline of this test file's own, per request as well as
 * overall — because the failure the unclaimed-item tests guard against is a **hang**.
 *
 * An item nobody claims makes Chromium open a native modal Save As dialog on a hidden window,
 * and a main process sitting behind one stops answering HTTP altogether. So every request here
 * carries its own timeout and a failure to answer is reported as what it is, rather than being
 * left to surface as vitest's own timeout with no explanation attached.
 */
const boundedSettle = async (base: string, id: string, ms: number): Promise<JobBody> => {
  const deadline = Date.now() + ms;
  for (;;) {
    let body: JobBody;
    try {
      const res = await fetch(`${base}/gh/jobs/${id}`, { signal: AbortSignal.timeout(5_000) });
      body = (await res.json()) as JobBody;
    } catch (e: unknown) {
      // A main process wedged behind a modal dialog stops answering. Name that, rather than
      // letting it read as a network blip.
      throw new Error(
        `polling job ${id} failed after ${ms - (deadline - Date.now())}ms — the app stopped ` +
          `answering, which is what an unclaimed download item looks like: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

      /**
       * Dedupe, asserted at the ONLY point it is reachable: while the first job is still
       * running.
       *
       * The record's `url` is the recipe's startUrl, which is what keeps dedupe, the logs and
       * `/gh/jobs/:id` working unchanged. `findOpen` matches only UNSETTLED records, so this
       * has to go out now — a second POST issued after the job settles cannot fold, mints a
       * fresh id, and submits a second real recipe job against a host this test is about to
       * close. The margin is wide: this request is on the wire within a millisecond of the
       * first 202, and the job it folds onto has a window to open, a page to load, a 300ms
       * reveal to wait out and half a megabyte to fetch before it settles.
       *
       * What this cannot see is the submit count — `test/unit/gh.test.ts` ("dedupes an
       * in-flight request for the same target") holds that half, asserting one submit.
       */
      const again = await post(gh.url, { recipe: recipeFor(host.url), site: 'reveal' });
      expect(again.status).toBe(202);
      const folded = (await again.json()) as { jobId: string; state: string };
      expect(folded.jobId, 'the second POST minted a new job instead of folding onto the first').toBe(id);
      expect(SETTLED, `the first job settled before the second POST could fold onto it`)
        .not.toContain(folded.state);

      const done = await settle(gh.url, id);

      expect(done.error).toBeUndefined();
      expect(done.state).toBe('done');
      // The hash is the proof it fetched the FILE and not the page it started from: the page
      // is served on the same origin and would settle `done` just as happily.
      expect(done.result!.sha256).toBe(SHA);
      expect(done.result!.size).toBe(BODY.length);
      expect((await stat(done.result!.path)).size).toBe(BODY.length);
      expect(done.result!.filename).toBe('revealed.bin');

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
   * It is NOT the regression net for handler ordering, though it was written expecting to be:
   * the click that starts this download happens long after `loadURL` has resolved, so moving
   * the `will-download` attach after the navigation leaves this test green. That rule is pinned
   * by the `duringLoad` test below, which is the only one whose download lands inside the
   * interval where the ordering makes a difference.
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

describe('a download that starts while the page is still loading', () => {
  /**
   * **The test that pins handler ordering, and the only one that can.**
   *
   * `will-download` is attached before `wc.loadURL()` runs, and that placement is the whole
   * rule: an item nobody claims makes Chromium open a native modal Save As dialog that never
   * resolves — on a headless daemon that is a wedged job behind a window no one can see or
   * dismiss. Every other recipe test here starts its download from a *click*, which happens
   * long after the load, so all of them stay green with the handler attached late. They do not
   * test the rule; this one does.
   *
   * The fixture's download begins during the page's own load, so it lands in the one interval
   * where "before the navigation" and "after it" differ. Move the attach after `loadURL` and
   * this goes red: the item is missed, no `a#link` ever appears, and the job fails
   * `recipe-failed` on the `waitFor` step deadline instead of completing on the bytes.
   *
   * It polls through `boundedSettle`, because the failure this guards against is a *hang*: if
   * an unclaimed item ever did block the main process, the poll must fail as our timeout rather
   * than as vitest's.
   */
  it('claims the item even though nothing clicked, and completes on its bytes', async () => {
    const host = await startRecipeHost({ mode: 'duringLoad', body: BODY, filename: 'duringload.bin' });
    const started = Date.now();
    try {
      const id = await fetchRecipe(gh.url, host.url, 'during-load');
      const done = await boundedSettle(gh.url, id, 45_000);
      const took = Date.now() - started;

      expect(done.error, `expected the item to be claimed, not a recipe failure`).toBeUndefined();
      expect(done.state).toBe('done');
      // The hash again: the page and the file are served from one origin, so a job that
      // downloaded the *page* would settle `done` just as happily.
      expect(done.result!.sha256).toBe(SHA);
      expect(done.result!.size).toBe(BODY.length);
      expect((await stat(done.result!.path)).size).toBe(BODY.length);
      expect(done.result!.filename).toBe('duringload.bin');

      // It completed on the ITEM, not on a step. No `a#link` exists on this page, so a job
      // that waited for the recipe would have spent the whole 15s step deadline and failed.
      // This bound is what says the item was claimed the moment it appeared.
      expect(took, `the item was not claimed during the load: it took ${took}ms`).toBeLessThan(10_000);

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

describe('a page that starts a second download', () => {
  /**
   * **The regression net for the fatal one.**
   *
   * `will-download` fires on the SESSION, and a page may start as many downloads as it likes.
   * The handler used to remove itself the moment it adopted its item, which meant every later
   * item from the same window reached the session with nobody willing to claim it: a sibling
   * job's handler rejects it on `webContents`, so nothing calls `setSavePath`, and the item
   * becomes Chromium's to dispose of. What it actually does with it was measured, and it is not
   * the modal the design predicted — see the assertion on the app's log below, which is the only
   * one here that can tell the two builds apart.
   *
   * Increment 2b never had this exposure, because no page ran on the plain download path.
   * Recipes created it, so the proof belongs here.
   *
   * The engine now keeps the listener attached for the window's whole life and claims every
   * item, keeping the first and cancelling the rest onto a throwaway save path. The throwaway
   * matters as much as the claim: Chromium DELETES the file of an item it cancelled, so
   * pointing a doomed item at `<id>.part` — the adopted item's live file — would delete the
   * download being kept. The directory assertion below is what holds both halves.
   */
  it('completes on the first item, discards the second, and keeps answering', async () => {
    const host = await startRecipeHost({ mode: 'twice', body: BODY, filename: 'twice.bin' });
    try {
      const id = await fetchRecipe(gh.url, host.url, 'twice');
      const done = await boundedSettle(gh.url, id, 45_000);

      expect(done.error, 'the job failed instead of completing on its first item').toBeUndefined();
      expect(done.state).toBe('done');
      // The page and the file are served from one origin, so a job that downloaded the *page*
      // would settle `done` just as happily. The hash is what says it got the file.
      expect(done.result!.sha256).toBe(SHA);
      expect(done.result!.size).toBe(BODY.length);
      expect((await stat(done.result!.path)).size).toBe(BODY.length);

      // The fixture really did start two downloads. Without this the test would pass just as
      // happily against a page that only ever started one, which is to say against nothing.
      expect(host.fileRequests(), 'the page did not start a second download').toBeGreaterThanOrEqual(2);

      /**
       * **And the ENGINE saw the second one**, which is the assertion the rest of this test
       * cannot make.
       *
       * What Chromium does with an item nobody claims turns out not to be the modal the design
       * predicted — measured on Electron 43.4.1 / Windows 11, it falls through to the browser's
       * default download routine and writes the whole file into the user's own Downloads folder
       * under a UUID `.tmp` name. Silent, outside the store, invisible to retention, and it
       * grows without bound on a daemon. The job still completes, so every HTTP-level assertion
       * above passes with the handler detaching on adoption exactly as it does without.
       *
       * The log line is the difference. It is written on the claim-and-cancel branch and
       * nowhere else, so it says the item reached a handler that wanted it, rather than
       * reaching the session with nobody left to answer for it.
       */
      const discarded = `"id":"${id}","extras":1`;
      const deadline = Date.now() + 5_000;
      // The pipe is asynchronous: the line is written before the job settles, but the chunk
      // carrying it may not have crossed yet.
      while (!gh.output().includes(discarded) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(gh.output(), 'the engine never claimed the second item; Chromium was left to ' +
        'decide what to do with it, which is a file in the user’s Downloads folder')
        .toContain(discarded);

      /**
       * Exactly one file, and it is the finished one.
       *
       * This is the assertion about the throwaway path. A discarded item saved to `<id>.part`
       * and then cancelled would have deleted the adopted item's bytes — the job would fail to
       * finalise rather than leave a file. And a throwaway that Chromium did NOT clean up would
       * show here as an `<id>.part.extra-1` left behind.
       */
      expect(await readdir(dir).then((f) => f.filter((n) => n.startsWith(id)).sort()))
        .toEqual([`${id}.bin`]);

      /**
       * And the process is still there.
       *
       * The measured disposal is silent, but the documented one — a native modal on the hidden
       * window — is not, and a main process behind one answers nothing at all. This request is
       * bounded and issued after both downloads have been served, so it is the direct statement
       * that no dialog was raised on this platform either. `DELETE` rather than a read, so it
       * has to reach the store and act.
       */
      const del = await fetch(`${gh.url}/gh/jobs/${id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5_000),
      });
      expect(del.status, 'the app stopped answering after the second item').toBe(204);
    } finally {
      await host.close();
    }
  }, 120_000);
});
