/// <reference lib="dom" />
/**
 * The recipe bridge, running in the isolated world.
 *
 * This exists so that a caller-supplied selector never becomes code. `executeJavaScript` takes
 * only a string, so driving the DOM that way would mean building one out of caller input —
 * the thing every module in this project has avoided. Here the step arrives as structured data
 * over IPC and is passed to `querySelectorAll` as an argument.
 *
 * `contextIsolation` keeps this out of the page's reach: the page cannot see `ipcRenderer`,
 * cannot call these handlers, and cannot observe the channel. Nothing is exposed on `window` —
 * this bridge answers the main process and nobody else.
 *
 * The DOM half is the one part of the feature no unit test can reach: it needs a real document
 * and a real `ipcRenderer`. It is covered end to end against a live page instead.
 *
 * **Loading it takes two things this project does not do anywhere else**, both measured against
 * Electron 43.4.1 rather than reasoned about:
 *
 *  - The file must reach the window as `.mjs`. Electron parses a `.js` preload as CommonJS no
 *    matter what `package.json` says, so the `dist/preload/recipe.js` that `tsc` emits fails to
 *    load with `Cannot use import statement outside a module` — and it fails *quietly*, on
 *    `preload-error`, leaving a live window whose steps simply never answer.
 *  - That window must be created with `sandbox: false`. A sandboxed preload refuses ESM
 *    outright, so `.mjs` alone still does not load. Every other window here is sandboxed; this
 *    one cannot be. It is the narrowest possible exception — the window exists only to run a
 *    validated recipe, `contextIsolation` still stands between this code and the page, and
 *    `nodeIntegration` stays off, so the page gets nothing it did not already have.
 */
import { ipcRenderer } from 'electron';
import { STEP_CHANNEL, RESULT_CHANNEL, type RecipeStep, type StepResult } from '../downloads/recipe.js';

/** How often to re-look while waiting for a step's element. Fast enough to feel immediate. */
const POLL_MS = 100;
/** A DOM exception message embeds the selector, and the selector may be 512 characters. */
const MAX_ERROR = 200;

type Found = { ok: true; el: Element | null } | { ok: false; error: string };

/** First element matching the selector, and the text filter when the step carries one. */
function match(step: RecipeStep): Found {
  let nodes: Element[];
  try {
    nodes = Array.from(document.querySelectorAll(step.selector));
  } catch (e: unknown) {
    // `validateRecipe` deliberately cannot check CSS validity — it has no DOM — so this is
    // where an invalid selector surfaces. It ends the step NOW rather than polling to the
    // deadline: a selector that does not parse will not start parsing later, and reporting
    // it as "matched nothing" would send an operator looking at the page's markup.
    return { ok: false, error: `has an invalid selector (${clip(errorText(e))})` };
  }
  if (step.op === 'readAttribute' || step.text === undefined) return { ok: true, el: nodes[0] ?? null };
  const want = step.text.trim().toLowerCase();
  return { ok: true, el: nodes.find((n) => (n.textContent ?? '').trim().toLowerCase() === want) ?? null };
}

async function run(step: RecipeStep, deadline: number): Promise<StepResult> {
  for (;;) {
    const found = match(step);
    if (!found.ok) return found;
    const el = found.el;
    if (el) {
      if (step.op === 'waitFor') return { ok: true, value: null };
      if (step.op === 'readAttribute') return { ok: true, value: el.getAttribute(step.attribute) };
      // `click()` is on HTMLElement and SVGElement but not on Element at large, and a selector
      // is free to match something else. A named failure beats a TypeError from the handler.
      if (typeof (el as Partial<HTMLElement>).click !== 'function') {
        return { ok: false, error: 'matched an element that cannot be clicked' };
      }
      (el as HTMLElement).click();
      return { ok: true, value: null };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: 'matched nothing within the step timeout' };
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, remaining)));
  }
}

/**
 * Answer exactly once, and never throw doing it. The window can be gone by the time a step
 * finishes, and an exception out of an IPC handler is an unhandled rejection in the app.
 */
function reply(seq: number, result: StepResult): void {
  try {
    ipcRenderer.send(RESULT_CHANNEL, seq, result);
  } catch {
    // The frame is being torn down, or the payload would not clone. The main process has its
    // own deadline for this step; there is nothing to recover here and nowhere to log to.
  }
}

/**
 * The one listener. It has no removal path on purpose: it is the whole module, it is attached
 * once per renderer at preload time, and it dies with the frame that owns it — Electron
 * discards the `ipcRenderer` along with the context, so there is no exit at which a live
 * listener could outlast anything. The per-step resources it creates — one poll timer at a
 * time, bounded by the deadline the main process hands down — all end with the step.
 */
ipcRenderer.on(STEP_CHANNEL, (_event, seq: number, step: RecipeStep, deadline: number) => {
  void run(step, deadline).then(
    (result) => reply(seq, result),
    // Nothing may escape: an unhandled rejection in a preload is still a fault in the app.
    (e: unknown) => reply(seq, { ok: false, error: `failed in the page (${clip(errorText(e))})` }),
  );
});

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clip(s: string): string {
  return s.length <= MAX_ERROR ? s : `${s.slice(0, MAX_ERROR)}...`;
}
