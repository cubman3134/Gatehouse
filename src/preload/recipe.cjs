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
 * **Why this file is hand-written CommonJS and not TypeScript**, measured against Electron
 * 43.4.1 rather than reasoned about:
 *
 *  - A preload is only ever loaded as ESM when its path ends in `.mjs`. Electron parses a
 *    `.js` preload as CommonJS no matter what `package.json` says, so the
 *    `dist/preload/recipe.js` that `tsc` emits from an ESM source fails to load with
 *    `Cannot use import statement outside a module` — and it fails *quietly*, on
 *    `preload-error`, leaving a live window whose steps simply never answer.
 *  - A **sandboxed** preload refuses ESM outright, so `.mjs` would additionally cost
 *    `sandbox: false`. That trade was measured and refused: a sandboxed CommonJS preload can
 *    `require('electron')` for `ipcRenderer` and can touch the DOM, which is everything this
 *    file needs. The sandbox is a real part of the posture every window in this project holds
 *    against a hostile renderer; the file format is not. So the format gave way instead, and
 *    the window that loads this file is created with `sandbox: true` like all the others.
 *
 * Being CommonJS puts it outside the TypeScript program, which is the second reason to keep it
 * hand-written: the TS version needed `/// <reference lib="dom" />` to type `document`, and
 * that reference leaked the DOM globals into every other module in the program — modules
 * running in the main process, which have no DOM and no business naming one.
 */
'use strict';

const { ipcRenderer } = require('electron');

/**
 * The two IPC channel names, duplicated by necessity.
 *
 * They are minted in `src/downloads/recipe.ts`, which is where the main-process half reads
 * them from. This file cannot import that module — a CommonJS preload cannot `require` an ESM
 * source, and it must not be part of the TypeScript program at all — so it restates the
 * values. `test/unit/preload.test.ts` reads this file and asserts the two agree, because a
 * channel name that drifts fails *silently*: the sender sends into a channel nobody listens
 * on, the step never answers, and every recipe dies of a timeout with a message that describes
 * the page rather than the wiring.
 *
 * Keep the declarations on one line each and single-quoted; that test matches on their shape.
 */
const STEP_CHANNEL = 'gatehouse:recipe-step';
const RESULT_CHANNEL = 'gatehouse:recipe-result';

/** How often to re-look while waiting for a step's element. Fast enough to feel immediate. */
const POLL_MS = 100;
/** A DOM exception message embeds the selector, and the selector may be 512 characters. */
const MAX_ERROR = 200;

/**
 * First element matching the selector, and the text filter when the step carries one.
 * Returns `{ ok: true, el }` with a possibly-null element, or `{ ok: false, error }`.
 */
function match(step) {
  let nodes;
  try {
    nodes = Array.from(document.querySelectorAll(step.selector));
  } catch (e) {
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

/** Run one step against the live document, polling until it matches or the deadline passes. */
async function run(step, deadline) {
  for (;;) {
    const found = match(step);
    if (!found.ok) return found;
    const el = found.el;
    if (el) {
      if (step.op === 'waitFor') return { ok: true, value: null };
      if (step.op === 'readAttribute') return { ok: true, value: el.getAttribute(step.attribute) };
      // `click()` is on HTMLElement and SVGElement but not on Element at large, and a selector
      // is free to match something else. A named failure beats a TypeError from the handler.
      if (typeof el.click !== 'function') {
        return { ok: false, error: 'matched an element that cannot be clicked' };
      }
      el.click();
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
function reply(seq, result) {
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
ipcRenderer.on(STEP_CHANNEL, (_event, seq, step, deadline) => {
  void run(step, deadline).then(
    (result) => reply(seq, result),
    // Nothing may escape: an unhandled rejection in a preload is still a fault in the app.
    (e) => reply(seq, { ok: false, error: `failed in the page (${clip(errorText(e))})` }),
  );
});

function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}

function clip(s) {
  return s.length <= MAX_ERROR ? s : `${s.slice(0, MAX_ERROR)}...`;
}
