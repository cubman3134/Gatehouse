# Gatehouse Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /gh/fetch` accepts an optional declarative `recipe`, runs it in one hidden window on the target session, and downloads the derived URL **from that same window** — so a site whose download URL is minted by a click and bound to the session that minted it can be fetched.

**Architecture:** A recipe is validated in a pure module, then executed step-by-step over **IPC through an isolated-world preload** — never by building a script string. The derived URL is treated as hostile input and re-validated before the download starts. Everything downstream (store, retention, `will-download` correlation, Range serving, DELETE, polling) is untouched.

**Tech Stack:** TypeScript, ESM, Electron 43, Vitest. No new runtime dependencies.

## Why this exists

Measured against romhackplaza.org, 2026-08-23. Its download URL is minted by a Livewire click and is **session-coupled**:

| the same URL, same uuid, fetched from | result |
|---|---|
| Gatehouse's own session, via `/gh/fetch` | `network`, 0 bytes, interrupted |
| the session that opened the modal | **completed, 2,215 bytes** |

So the spec's "Allarr derives, Gatehouse fetches" split cannot express this source. Full reasoning in [the design](../specs/2026-08-23-gatehouse-recipes-design.md).

## Global Constraints

- Node >= 22.12.0, Electron pinned `43.4.1`, TypeScript, ESM, Vitest. Relative imports carry a `.js` extension.
- `npm test` stays `tsc && vitest run`.
- **No AI attribution in commits.** Conventional prefixes.
- **`/v1` is untouchable** — increment 1 is live in production against a real rig.
- **`/gh/*`'s wire contract changes in exactly one way:** `/gh/fetch` requires **exactly one of `url` or `recipe`** (neither → 400, both → 400), and `referer` alongside `recipe` → 400. Nothing else — same routes, same `202 {jobId,state}`, same job body, same `{"error":{"code","message"}}`.
- **No caller string may become code.** Steps cross to the page over IPC; there is no `executeJavaScript` on a caller-derived string anywhere in this increment.
- **The derived URL is hostile input** and goes back through `validateTarget` before any download.
- `browserDownload` remains the only terminal-state writer; a record settles only after its writer released the file.
- No promise rejection may escape into a `void`ed call site.
- Recipes are **not persisted**. A recipe download interrupted by a restart is not resumed; the caller re-POSTs. This keeps caller selectors out of the manifest and avoids re-deriving a session-coupled URL after the session is gone.

## File Structure

| Path | Responsibility |
|---|---|
| `src/downloads/recipe.ts` | The step types, `validateRecipe` (pure), and `runRecipe` (drives IPC). |
| `src/preload/recipe.ts` | Isolated-world preload: receives a step, does the DOM work, replies. |
| `src/downloads/browser.ts` | *(modify)* a recipe branch before the download starts |
| `src/api/gh.ts` | *(modify)* accept `recipe`, enforce the exclusivity rules |
| `src/config.ts` | *(modify)* two new timeouts |
| `src/downloads/record.ts` | *(modify)* add `recipe-failed` to the failure codes |
| `test/fixture/recipehost.ts` | A local page that mimics the measured click→reveal→download flow |

---

### Task 1: Step types and validation

**Files:**
- Create: `src/downloads/recipe.ts`
- Modify: `src/downloads/record.ts` (add the failure code)
- Test: `test/unit/recipe.test.ts`

**Interfaces:**
- Consumes: `validateTarget`, `isTargetError` from `src/api/target.ts`
- Produces:
  - `type RecipeStep = { op: 'click'; selector: string; text?: string } | { op: 'waitFor'; selector: string; text?: string } | { op: 'readAttribute'; selector: string; attribute: string }`
  - `interface Recipe { startUrl: string; steps: RecipeStep[] }`
  - `interface RecipeError { message: string }`
  - `function validateRecipe(raw: unknown): Recipe | RecipeError`
  - `function isRecipeError(x: unknown): x is RecipeError`
  - `const MAX_STEPS = 12`

- [ ] **Step 1: Write the failing test**

Create `test/unit/recipe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateRecipe, isRecipeError, MAX_STEPS } from '../../src/downloads/recipe.js';

const ok = {
  startUrl: 'https://example.test/item',
  steps: [
    { op: 'click', selector: 'button', text: 'Download' },
    { op: 'waitFor', selector: 'a[href*="/api/"]' },
    { op: 'readAttribute', selector: 'a[href*="/api/"]', attribute: 'href' },
  ],
};

describe('validateRecipe', () => {
  it('accepts the shape the measured site needs', () => {
    const r = validateRecipe(ok);
    expect(isRecipeError(r)).toBe(false);
    if (!isRecipeError(r)) {
      expect(r.startUrl).toBe('https://example.test/item');
      expect(r.steps).toHaveLength(3);
      expect(r.steps[2]).toEqual({ op: 'readAttribute', selector: 'a[href*="/api/"]', attribute: 'href' });
    }
  });

  it('forwards the parsed startUrl, not the raw string', () => {
    const r = validateRecipe({ ...ok, startUrl: 'https://example.test' });
    expect(isRecipeError(r) ? '' : r.startUrl).toBe('https://example.test/');
  });

  // THE SAFETY GATE. startUrl goes through the same allow-list as any caller URL.
  it('refuses a non-http startUrl', () => {
    for (const u of ['file:///C:/x', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      expect(isRecipeError(validateRecipe({ ...ok, startUrl: u })), u).toBe(true);
    }
  });

  it('refuses a non-object, a missing steps array, and an empty one', () => {
    expect(isRecipeError(validateRecipe(null))).toBe(true);
    expect(isRecipeError(validateRecipe('nope'))).toBe(true);
    expect(isRecipeError(validateRecipe([ok]))).toBe(true);
    expect(isRecipeError(validateRecipe({ startUrl: ok.startUrl }))).toBe(true);
    expect(isRecipeError(validateRecipe({ ...ok, steps: [] }))).toBe(true);
  });

  it('refuses more than MAX_STEPS', () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, () => ({ op: 'waitFor', selector: 'a' }));
    many[many.length - 1] = { op: 'readAttribute', selector: 'a', attribute: 'href' } as never;
    const r = validateRecipe({ ...ok, steps: many });
    expect(isRecipeError(r)).toBe(true);
    if (isRecipeError(r)) expect(r.message).toMatch(/at most/i);
  });

  it('refuses an unknown op', () => {
    const r = validateRecipe({ ...ok, steps: [{ op: 'evaluate', selector: 'a' }] });
    expect(isRecipeError(r)).toBe(true);
    if (isRecipeError(r)) expect(r.message).toMatch(/step 0/);
  });

  it('names the offending step index', () => {
    const r = validateRecipe({
      ...ok,
      steps: [ok.steps[0], { op: 'click' }, ok.steps[2]],
    });
    expect(isRecipeError(r)).toBe(true);
    if (isRecipeError(r)) expect(r.message).toMatch(/step 1/);
  });

  it('refuses an oversized selector or text', () => {
    expect(isRecipeError(validateRecipe({ ...ok, steps: [{ op: 'readAttribute', selector: 'a'.repeat(513), attribute: 'href' }] }))).toBe(true);
    expect(isRecipeError(validateRecipe({ ...ok, steps: [{ op: 'click', selector: 'a', text: 'x'.repeat(201) }, ok.steps[2]] }))).toBe(true);
  });

  it('refuses a hostile attribute name', () => {
    for (const a of ['href onload', 'href"', '', 'a'.repeat(80)]) {
      const r = validateRecipe({ ...ok, steps: [{ op: 'readAttribute', selector: 'a', attribute: a }] });
      expect(isRecipeError(r), JSON.stringify(a)).toBe(true);
    }
  });

  it('refuses text on readAttribute and attribute on click', () => {
    expect(isRecipeError(validateRecipe({ ...ok, steps: [{ op: 'readAttribute', selector: 'a', attribute: 'href', text: 'x' }] }))).toBe(true);
    expect(isRecipeError(validateRecipe({ ...ok, steps: [{ op: 'click', selector: 'a', attribute: 'href' }, ok.steps[2]] }))).toBe(true);
  });

  // A recipe that runs to completion must END with something that yields a URL, or there is
  // nothing to download and the failure would surface late instead of at validation.
  it('refuses a recipe whose last step is not readAttribute', () => {
    for (const last of [{ op: 'click', selector: 'a' }, { op: 'waitFor', selector: 'a' }]) {
      const r = validateRecipe({ ...ok, steps: [ok.steps[0], last] });
      expect(isRecipeError(r)).toBe(true);
      if (isRecipeError(r)) expect(r.message).toMatch(/readAttribute/);
    }
  });

  it('accepts a single readAttribute step', () => {
    expect(isRecipeError(validateRecipe({ ...ok, steps: [ok.steps[2]] }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/unit/recipe.test.ts`
Expected: FAIL — cannot resolve `../../src/downloads/recipe.js`

- [ ] **Step 3: Add the failure code**

**Verified location:** `FailureCode` is defined in `src/jobs/queue.ts:3` and re-exported from `src/downloads/record.ts:74`. Add `'recipe-failed'` to the union **in `src/jobs/queue.ts`** and leave the re-export alone. Do not create a second definition.

Give it a comment saying it covers a step that matched nothing, a recipe that ran out of time, and a derived URL the scheme gate refused — and that reporting any of those as `network` would be a lie.

Check whether `queue.ts` also carries a runtime whitelist of codes (`errorOf` validates against one). If it does, add `'recipe-failed'` there too, or the code will be silently rewritten to `network` on its way through the queue — which would defeat the entire point of the failure message.

- [ ] **Step 4: Implement the validation half of `src/downloads/recipe.ts`**

```ts
import { validateTarget, isTargetError } from '../api/target.js';

export type RecipeStep =
  | { op: 'click'; selector: string; text?: string }
  | { op: 'waitFor'; selector: string; text?: string }
  | { op: 'readAttribute'; selector: string; attribute: string };

export interface Recipe {
  startUrl: string;
  steps: RecipeStep[];
}

export interface RecipeError { message: string }

export function isRecipeError(x: unknown): x is RecipeError {
  return typeof x === 'object' && x !== null && 'message' in x && !('steps' in x);
}

/** Four times what the one measured site needed. A constant, not a setting. */
export const MAX_STEPS = 12;
const MAX_SELECTOR = 512;
const MAX_TEXT = 200;

/** A conservative HTML attribute name. Anything else is refused rather than escaped. */
const ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/**
 * Validate a caller-supplied recipe.
 *
 * Everything here is refused rather than coerced, and every message names the step index —
 * a recipe breaks when a site changes its markup, and "step 2 matched nothing" is the whole
 * difference between one log line and an afternoon.
 */
export function validateRecipe(raw: unknown): Recipe | RecipeError {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { message: 'recipe must be an object' };
  }
  const r = raw as Record<string, unknown>;

  // The same allow-list any caller URL passes through — `file:` and friends refused identically.
  const target = validateTarget(r.startUrl, undefined);
  if (isTargetError(target)) return { message: `recipe.startUrl: ${target.message}` };

  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    return { message: 'recipe.steps must be a non-empty array' };
  }
  if (r.steps.length > MAX_STEPS) {
    return { message: `recipe.steps may hold at most ${MAX_STEPS} steps` };
  }

  const steps: RecipeStep[] = [];
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      return { message: `recipe step ${i} must be an object` };
    }
    const step = s as Record<string, unknown>;
    const selector = str(step.selector, MAX_SELECTOR);
    if (selector === null) {
      return { message: `recipe step ${i}: selector must be a string of 1..${MAX_SELECTOR} characters` };
    }

    if (step.op === 'click' || step.op === 'waitFor') {
      if ('attribute' in step) return { message: `recipe step ${i}: ${step.op} takes no attribute` };
      let text: string | undefined;
      if ('text' in step) {
        const t = str(step.text, MAX_TEXT);
        if (t === null) return { message: `recipe step ${i}: text must be a string of 1..${MAX_TEXT} characters` };
        text = t;
      }
      steps.push(text === undefined ? { op: step.op, selector } : { op: step.op, selector, text });
      continue;
    }

    if (step.op === 'readAttribute') {
      if ('text' in step) return { message: `recipe step ${i}: readAttribute takes no text` };
      const attribute = typeof step.attribute === 'string' ? step.attribute : '';
      if (!ATTRIBUTE.test(attribute)) {
        return { message: `recipe step ${i}: attribute is not a valid attribute name` };
      }
      steps.push({ op: 'readAttribute', selector, attribute });
      continue;
    }

    return { message: `recipe step ${i}: unknown op ${JSON.stringify(step.op)}` };
  }

  // A recipe that runs to completion has to end with something that yields a URL. The other
  // way a recipe legitimately ends — a download starting mid-flight — needs no last step at
  // all, so this is checked here rather than left to fail late with nothing to download.
  const last = steps[steps.length - 1]!;
  if (last.op !== 'readAttribute') {
    return { message: `recipe.steps must end with a readAttribute, not ${last.op}` };
  }

  return { startUrl: target.url, steps };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/recipe.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 6: Mutation-check the two gates that matter**

Restore between each, and report the failing test name and output for both:

1. Replace the `validateTarget` call with `const target = { url: String(r.startUrl), session: '' }` — `refuses a non-http startUrl` must go RED.
2. Delete the final `last.op !== 'readAttribute'` check — `refuses a recipe whose last step is not readAttribute` must go RED.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add src/downloads/recipe.ts src/downloads/record.ts test/unit/recipe.test.ts
git commit -m "feat: validate a caller-supplied recipe

startUrl goes through the same scheme allow-list as any caller URL, and every
message names the step index — a recipe breaks when a site changes its markup,
and naming the step is the difference between one log line and an afternoon.

A recipe that runs to completion must end with a readAttribute, checked here
rather than left to fail late with nothing to download."
```

---

### Task 2: The preload bridge and the executor

**Files:**
- Create: `src/preload/recipe.ts`
- Modify: `src/downloads/recipe.ts` (add `runRecipe`)
- Test: covered end to end in Task 3 — this cannot run without Electron

**Interfaces:**
- Produces:
  - `interface RecipeDeps { send: (step: RecipeStep, deadlineMs: number) => Promise<StepResult>; stepMs: number; totalMs: number; now: () => number }`
  - `type StepResult = { ok: true; value: string | null } | { ok: false; error: string }`
  - `function runRecipe(recipe: Recipe, deps: RecipeDeps): Promise<{ url: string } | RecipeError>`
  - Preload channel names exported as constants so both sides import one binding: `STEP_CHANNEL`, `RESULT_CHANNEL`

- [ ] **Step 1: Implement `src/preload/recipe.ts`**

```ts
/**
 * The recipe bridge, running in the isolated world.
 *
 * This exists so that a caller-supplied selector never becomes code. `executeJavaScript` takes
 * only a string, so driving the DOM that way would mean building one out of caller input —
 * the thing every module in this project has avoided. Here the step arrives as structured data
 * over IPC and is passed to `querySelectorAll` as an argument.
 *
 * `contextIsolation` keeps this out of the page's reach: the page cannot see `ipcRenderer`,
 * cannot call these handlers, and cannot observe the channel.
 */
import { ipcRenderer } from 'electron';

export const STEP_CHANNEL = 'gatehouse:recipe-step';
export const RESULT_CHANNEL = 'gatehouse:recipe-result';

interface Step { op: 'click' | 'waitFor' | 'readAttribute'; selector: string; text?: string; attribute?: string }

/** First element matching the selector, and the text filter when the step carries one. */
function match(step: Step): Element | null {
  let nodes: Element[];
  try {
    nodes = Array.from(document.querySelectorAll(step.selector));
  } catch {
    return null; // an invalid selector is a miss, not a crash
  }
  if (step.text === undefined) return nodes[0] ?? null;
  const want = step.text.trim().toLowerCase();
  return nodes.find((n) => (n.textContent ?? '').trim().toLowerCase() === want) ?? null;
}

async function run(step: Step, deadline: number): Promise<{ ok: boolean; value?: string | null; error?: string }> {
  for (;;) {
    const el = match(step);
    if (el) {
      if (step.op === 'waitFor') return { ok: true, value: null };
      if (step.op === 'click') {
        (el as HTMLElement).click();
        return { ok: true, value: null };
      }
      return { ok: true, value: el.getAttribute(step.attribute ?? '') };
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: `matched nothing within the step timeout` };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

ipcRenderer.on(STEP_CHANNEL, (_event, seq: number, step: Step, deadline: number) => {
  void run(step, deadline)
    .then((result) => ipcRenderer.send(RESULT_CHANNEL, seq, result))
    // Nothing may escape: an unhandled rejection in a preload is still a fault in the app.
    .catch((e: unknown) => ipcRenderer.send(RESULT_CHANNEL, seq, { ok: false, error: String(e) }));
});
```

**Verified:** `tsconfig.json`'s `include` is `["src/**/*.ts"]`, so this compiles with no config change — confirm `dist/preload/recipe.js` appears after `npx tsc`. Do not modify `tsconfig.json`.

The preload must be referenced by **absolute path** at window creation. Resolve it from `import.meta.url` in `main.ts` (the module that already knows where `dist` is), not by a relative string from `browser.ts` — a relative preload path resolves against the cwd, which is whatever directory the app was launched from.

- [ ] **Step 2: Add `runRecipe` to `src/downloads/recipe.ts`**

```ts
export type StepResult = { ok: true; value: string | null } | { ok: false; error: string };

export interface RecipeDeps {
  /** Send one step to the page and await its result. Task 3 wires this to IPC. */
  send: (step: RecipeStep, deadlineMs: number) => Promise<StepResult>;
  stepMs: number;
  totalMs: number;
  now: () => number;
}

/**
 * Run the steps in order and return the derived URL.
 *
 * The URL is NOT validated here — the caller does that, because it is the caller that holds
 * the scheme gate and the caller that must refuse it. Returning it raw keeps this function
 * about sequencing, and makes the gate impossible to skip by accident: `browser.ts` cannot use
 * the result without passing it through `validateTarget`.
 */
export async function runRecipe(recipe: Recipe, deps: RecipeDeps): Promise<{ url: string } | RecipeError> {
  const overall = deps.now() + deps.totalMs;
  let last: string | null = null;

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i]!;
    if (deps.now() >= overall) {
      return { message: `recipe ran out of time at step ${i} (${describe(step)}) after ${deps.totalMs}ms` };
    }
    const deadline = Math.min(deps.now() + deps.stepMs, overall);

    const result = await deps.send(step, deadline);
    if (!result.ok) {
      return { message: `step ${i} (${describe(step)}) ${result.error}` };
    }
    last = result.value;
  }

  if (last === null || last === '') {
    const i = recipe.steps.length - 1;
    return { message: `step ${i} (${describe(recipe.steps[i]!)}) read an empty value` };
  }
  return { url: last };
}

/** For a message an operator reads at 3am: which step, and what it was looking for. */
function describe(step: RecipeStep): string {
  const where = step.op === 'readAttribute' ? `${step.selector}@${step.attribute}` : step.selector;
  const text = 'text' in step && step.text ? ` text=${JSON.stringify(step.text)}` : '';
  return `${step.op} ${where}${text}`;
}
```

- [ ] **Step 3: Confirm it compiles and the suite is unchanged**

```bash
npx tsc --noEmit
npm test
```

Expected: clean, and the same count as after Task 1 (nothing calls `runRecipe` yet).

- [ ] **Step 4: Commit**

```bash
git add src/preload/recipe.ts src/downloads/recipe.ts
git commit -m "feat: run recipe steps over an isolated-world preload

A caller-supplied selector never becomes code: the step crosses to the page as
structured data over IPC and is passed to querySelectorAll as an argument.
executeJavaScript takes only a string, so driving the DOM that way would have
meant building one out of caller input.

runRecipe deliberately returns the derived URL unvalidated. The gate belongs to
the caller, and keeping it there means browser.ts cannot use the result without
passing it through validateTarget."
```

---

### Task 3: Wire it in, and prove it end to end

**Files:**
- Modify: `src/downloads/browser.ts`, `src/api/gh.ts`, `src/config.ts`, `README.md`
- Create: `test/fixture/recipehost.ts`, `test/integration/recipe.test.ts`
- Test: `test/unit/gh.test.ts` (extend), `test/unit/config.test.ts` (extend)

- [ ] **Step 1: Add the two settings**

`GATEHOUSE_RECIPE_STEP_MS` (default 15000, range 1000–120000) and `GATEHOUSE_RECIPE_TOTAL_MS` (default 60000, range 5000–600000), via the existing `intFrom` helper. Add config tests in the same shape as the existing download settings — **boundaries accepted as well as just-past-boundary rejected**.

- [ ] **Step 2: Accept `recipe` in `src/api/gh.ts`**

In `postFetch`, before the existing `validateTarget` call:

- If `body.recipe` is present **and** `body.url` is present → `400 bad-request`, "provide exactly one of url or recipe".
- If neither → `400`, same message.
- If `recipe` is present and `body.referer` is present → `400`, "referer is not accepted with a recipe; the browser sets its own from startUrl".
- If `recipe` is present, run `validateRecipe`; on a `RecipeError` → `400 bad-request` with its message.
- The store record's `url` becomes the recipe's `startUrl`, so dedupe, logging and `/gh/jobs` keep working unchanged. Carry the validated recipe in memory to the queue — **do not persist it on the record.**

Add unit tests: both-provided → 400, neither → 400, `referer` with a recipe → 400, an invalid recipe → 400 with the step-naming message, a valid recipe → 202, and that two recipe fetches for the same `startUrl`+`site` dedupe onto one job.

- [ ] **Step 3: Add the recipe branch to `src/downloads/browser.ts`**

The window for a recipe download gets the preload:

```ts
webPreferences: {
  partition: `persist:${session}`,
  preload: recipePreloadPath,   // absolute, resolved from import.meta.url in main.ts
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

Order inside `browserDownload`, and this ordering is load-bearing:

1. create the window
2. **attach the `will-download` handler** — before anything navigates. An unclaimed item opens a native modal Save As dialog that never resolves; that is measured, and on a daemon it is fatal.
3. `await wc.loadURL(recipe.startUrl)`
4. `await runRecipe(...)`, with `send` implemented as: `wc.send(STEP_CHANNEL, seq, step, deadline)` and a one-shot `ipcMain.on(RESULT_CHANNEL, …)` filtered by **sender webContents id and `seq`**. Remove the listener on every path.
5. **If an item was already adopted during the recipe, skip the remaining steps and let it be the result.** That is the second legitimate ending.
6. Otherwise pass the derived URL through `validateTarget`; on rejection fail `recipe-failed` naming the scheme.
7. `wc.downloadURL(validated.url)` — same window, which is the whole point.

A `RecipeError` fails the job `recipe-failed` with its message. Everything downstream is unchanged.

- [ ] **Step 4: Build the fixture**

Create `test/fixture/recipehost.ts` — a local HTTP server serving a page that mimics the measured flow: a `<button>` reading "Download" that, on click, reveals `<a href="/file.bin">` after ~300ms. Modes:

- `reveal` (default) — the measured flow;
- `direct` — the button triggers the download itself with no link ever appearing (covers ending 2);
- `hostile` — the revealed link's `href` is `file:///C:/Windows/win.ini` (covers the derived-URL gate);
- `never` — the button exists but nothing is ever revealed (covers the step timeout).

Serve the actual file bytes for `/file.bin` so a completed download can be hashed.

- [ ] **Step 5: Write the integration tests**

Create `test/integration/recipe.test.ts`, through the real spawned app:

1. **`reveal`** — a recipe completes, `result.sha256` matches an independent hash, `result.path` exists at the right size.
2. **`direct`** — the click starts the download itself; the job completes with the right bytes. This is ending 2 and it must not require a `readAttribute` to have produced anything.
3. **`hostile`** — the job fails `recipe-failed`, the message names the refused scheme, and **no file is written**. This is the sharpest test here.
4. **`never`** — the job fails `recipe-failed` **within the configured bound rather than hanging**, and the message names the step index and its selector. Run this app with a short `GATEHOUSE_RECIPE_STEP_MS`, and assert the elapsed time is under a bound — that is what makes it a test of the timeout rather than of patience.

- [ ] **Step 6: Build, run, and check for orphans**

```bash
npx tsc
npx vitest run test/integration/recipe.test.ts
npm test
```

Then check for orphaned Electron processes. A Gatehouse instance is legitimately running on port 8191 — leave it alone and report only what the run left behind.

- [ ] **Step 7: Prove the sharp ones have teeth**

Restore between each, and report each:

1. Skip the `validateTarget` call on the derived URL — the `hostile` test must go RED **on an assertion**, not a timeout.
2. Attach the `will-download` handler *after* `loadURL` instead of before — the `direct` test must go RED.
3. Remove the per-step deadline — the `never` test must go RED on its elapsed-time bound.

- [ ] **Step 8: Update the README and commit**

Document: the `recipe` field and its three verbs; the exactly-one-of rule and the `referer` refusal; the two new settings; `recipe-failed`; that recipes are **not persisted**, so a recipe download interrupted by a restart is not resumed and the caller re-POSTs; and the known risk that a recipe is a selector contract a site is under no obligation to keep.

Do not claim anything about a real site until Task 4 says so.

---

### Task 4: Live verification

**Files:** none — this task produces a result, and whatever fix its findings demand.

Increments 1, 2 and 2b each had a green suite that meant nothing against a real host, and increment 2's live run inverted its whole design. This is not a formality.

- [ ] **Step 1: Build and deploy**

`npm run build`, then restart the running instance through its Startup launcher (`…\Start Menu\Programs\Startup\Gatehouse.vbs`) via WMI `Win32_Process.Create`, so what is tested is what boots.

- [ ] **Step 2: Regress `/v1` first**

Solve a fresh session against a real challenge-protected host; confirm `status: ok`, a `cf_clearance` cookie and a non-empty `userAgent`. **If this fails, stop** — increment 1 is live and a regression there matters more than this feature.

- [ ] **Step 3: Run the real recipe**

`POST /gh/fetch` with the romhackplaza recipe from the design. Poll to `done`. Confirm: the state reaches `done`, `result.path` exists at the reported size, the file is the real archive and not an HTML error page, and `sha256` matches an independent hash of the file on disk.

- [ ] **Step 4: Serve and release**

`GET /gh/files/:id` whole and with a `Range`; then `DELETE` and confirm 204 → 404 → gone from disk.

- [ ] **Step 5: Report honestly**

Record the result in the README and the progress ledger. **If any step fails, that is the finding** — write it down with the measurement rather than working around it.

---

## Self-Review

**Spec coverage.** Every decision in the design maps to a task: caller-supplied recipes (1, 3), the declarative vocabulary and its validation (1), the `/gh/fetch` shape and the exactly-one-of rule (3), the preload/IPC rule that no caller string becomes code (2), the derived-URL gate (2 defines the seam, 3 wires it, 3's teeth check proves it), rule 4's attach-before-navigate ordering (3, with its own teeth check), step-naming failures (1, 2), the two bounds (3), and live verification (4). The design's "not in scope" list is respected — no shadow DOM, no loops, no form filling, no logins.

**Type consistency.** `RecipeStep`, `Recipe`, `RecipeError`, `isRecipeError`, `MAX_STEPS`, `StepResult`, `RecipeDeps`, `runRecipe` are all defined once in `src/downloads/recipe.ts`. `STEP_CHANNEL` and `RESULT_CHANNEL` are defined once in `src/preload/recipe.ts` and imported by `browser.ts`, so the two sides cannot drift — the same one-mint discipline `stalled.ts` already uses for `STALLED`. `validateTarget`/`isTargetError` keep their single home in `src/api/target.ts`. `FailureCode` keeps whichever single home it already has.

**One judgement call flagged for the reviewer.** `runRecipe` returns the derived URL *unvalidated*, and the gate lives at the call site in `browser.ts`. The alternative — validating inside `runRecipe` — would make the gate unskippable but would give a sequencing function a second job and a dependency on the URL policy. I chose the seam that keeps `runRecipe` testable without the policy, and covered the risk with a teeth check that deletes the call site's gate and demands the `hostile` test go red. If a reviewer disagrees, moving the gate inside is a small change and the test still applies.

**One thing this plan does not settle, deliberately.** Whether a mid-recipe `will-download` can arrive *between* steps in a way that leaves a step's IPC reply outstanding. The listener is removed on every path, so the reply is dropped rather than mishandled — but the interleaving has not been measured. Task 3's `direct` test exercises the common case; if the integration surfaces anything stranger, that is a finding to write down rather than paper over.
