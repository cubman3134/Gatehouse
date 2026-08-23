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
 * **What this cannot check:** whether a selector is valid CSS. That needs a DOM, and this
 * module is deliberately free of Electron so it can be unit-tested without a browser. An
 * invalid selector therefore passes here and throws from `querySelectorAll` at execution
 * time — the executor is responsible for catching that and re-raising it with the step index,
 * because "step 2 matched nothing" is the whole point of these messages.
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
      if (Object.hasOwn(step, 'attribute')) return { message: `recipe step ${i}: ${step.op} takes no attribute` };
      let text: string | undefined;
      if (Object.hasOwn(step, 'text')) {
        const t = str(step.text, MAX_TEXT);
        if (t === null) return { message: `recipe step ${i}: text must be a string of 1..${MAX_TEXT} characters` };
        text = t;
      }
      steps.push(text === undefined ? { op: step.op, selector } : { op: step.op, selector, text });
      continue;
    }

    if (step.op === 'readAttribute') {
      if (Object.hasOwn(step, 'text')) return { message: `recipe step ${i}: readAttribute takes no text` };
      const attribute = typeof step.attribute === 'string' ? step.attribute : '';
      if (!ATTRIBUTE.test(attribute)) {
        return { message: `recipe step ${i}: attribute is not a valid attribute name` };
      }
      steps.push({ op: 'readAttribute', selector, attribute });
      continue;
    }

    // NOT JSON.stringify: it throws on a BigInt, on a circular object, and on one whose
    // toJSON throws — and this function's contract is that it REFUSES rather than throws.
    // Unreachable from a JSON body today, but the signature says `unknown` and callers will
    // reasonably treat it as total.
    const shown = typeof step.op === 'string' ? JSON.stringify(step.op) : typeof step.op;
    return { message: `recipe step ${i}: unknown op ${shown}` };
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

/**
 * The two IPC channels the recipe bridge speaks, minted once, here.
 *
 * They live in *this* module rather than in the preload because the preload is the one file
 * that imports `electron` as a value, and the other side of these channels is `browser.ts`,
 * which must never do that: it takes only `import type` from electron so its unit test can
 * load it outside an Electron runtime. An `import { STEP_CHANNEL } from '../preload/recipe.js'`
 * in `browser.ts` would drag `ipcRenderer.on` into the main process at import time — where
 * `ipcRenderer` is undefined — and take `test/unit/browser.test.ts` down with it.
 *
 * So the pure module holds the mint and both sides import it, for the same reason `stalled.ts`
 * holds its symbol alone: a channel name that drifts fails *silently*. The sender sends into a
 * channel nobody listens on, the step never answers, and every recipe dies of the step timeout
 * with a message that describes the page rather than the wiring.
 *
 * The mint is single only on this side. `src/preload/recipe.cjs` is hand-written CommonJS,
 * outside the TypeScript program and unable to import this module, so it restates these two
 * values literally. `test/unit/preload.test.ts` reads that file and asserts the two agree —
 * the guard that stands in for the single mint the preload cannot have. Change a value here
 * and change it there.
 */
export const STEP_CHANNEL = 'gatehouse:recipe-step';
export const RESULT_CHANNEL = 'gatehouse:recipe-result';

/** What one step's execution in the page came back with. `value` is only ever read off the last. */
export type StepResult = { ok: true; value: string | null } | { ok: false; error: string };

export interface RecipeDeps {
  /**
   * Send one step to the page and await its result. Task 3 wires this to IPC.
   *
   * **It MUST settle by `deadlineMs`, and settling is the caller's job, not this module's.**
   * Everything below measures time with the injected `now`, which means it can enforce a
   * budget *between* steps and nothing at all *during* one: a `send` that never settles hangs
   * the recipe past every deadline here, forever, holding its job slot. That is not
   * hypothetical — a preload that fails to load produces exactly it, and this was measured
   * doing so.
   *
   * So the implementation MUST race the IPC reply against `deadlineMs` and resolve
   * `{ ok: false, error: … }` when the timer wins, rather than waiting on a reply that may
   * never come. `runRecipe` cannot do this for it and does not try: there is no timer here to
   * cancel a `Promise` this module did not create. Nor may the loser of that race be left to
   * reject later into nothing — a reply arriving after the timeout is dropped, not thrown.
   * The unit tests below settle `send` themselves, so nothing in this file can catch a
   * `send` that forgets; only the wiring's own test can.
   */
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
 *
 * Total, like `validateRecipe`: every way this can end is a value, including a `send` that
 * rejects. A recipe runs on a daemon's job path, and a rejection escaping into a `void`ed
 * call site there is the fault this project has already fixed three times.
 */
export async function runRecipe(recipe: Recipe, deps: RecipeDeps): Promise<{ url: string } | RecipeError> {
  // `validateRecipe` cannot produce this, but the signature takes a `Recipe`, and the empty
  // case would otherwise reach `steps[-1]` and throw out of the last message it tried to build.
  if (recipe.steps.length === 0) return { message: 'recipe has no steps' };

  const overall = deps.now() + deps.totalMs;
  let last: string | null = null;

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i]!;
    if (deps.now() >= overall) {
      return { message: `recipe ran out of time at step ${i} (${describe(step)}) after ${deps.totalMs}ms` };
    }
    // The smaller of the two budgets, so a late step cannot spend a full step timeout past the
    // end of the overall one — the page half polls to whatever deadline it is handed.
    const deadline = Math.min(deps.now() + deps.stepMs, overall);

    let result: StepResult;
    try {
      result = await deps.send(step, deadline);
    } catch (e: unknown) {
      // A dead renderer, a window closed mid-flight, a payload that would not clone.
      result = { ok: false, error: `could not be sent to the page (${errorText(e)})` };
    }
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

/** Never `JSON.stringify`, and never the stack: this string goes into a job record. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
