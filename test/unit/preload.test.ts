import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { recipePreloadPath } from '../../src/preload/path.js';
import { STEP_CHANNEL, RESULT_CHANNEL } from '../../src/downloads/recipe.js';

/**
 * The preload is hand-written CommonJS living outside the TypeScript program, so nothing about
 * it is checked by `tsc` and it cannot import the channel mint in `src/downloads/recipe.ts`.
 * It restates those two values literally. These tests are the guard that stands in for the
 * single mint it cannot have — and for the compile step it does not get.
 *
 * It cannot simply be `require`d here: it calls `require('electron')` and `ipcRenderer.on` at
 * load time, neither of which exists outside an Electron renderer. So it is read as text.
 */
const path = recipePreloadPath();
const source = existsSync(path) ? readFileSync(path, 'utf8') : '';

/** Matches the one-line `const NAME = 'value';` form the preload is documented to keep. */
function declared(name: string): string | null {
  const m = new RegExp(`^const ${name} = '([^']*)';$`, 'm').exec(source);
  return m?.[1] ?? null;
}

describe('the recipe preload file', () => {
  it('is where recipePreloadPath says it is', () => {
    // Resolved from `import.meta.url`, so this holds whatever the working directory is. It is
    // also the whole reason there is no copy-into-dist step to forget: one state, not two.
    expect(existsSync(path)).toBe(true);
    expect(path.replace(/\\/g, '/')).toMatch(/\/src\/preload\/recipe\.cjs$/);
  });

  it('is CommonJS, because a sandboxed preload cannot be ESM', () => {
    // The measured pair of facts: Electron loads a preload as ESM only from `.mjs`, and a
    // sandboxed preload refuses ESM. `.cjs` is what keeps `sandbox: true` affordable, so an
    // `import` statement creeping in here is a window that silently never answers a step.
    expect(source).toContain("require('electron')");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s/m);
  });
});

describe('the preload channel names', () => {
  it('agree with the mint in downloads/recipe.ts', () => {
    // A drift here fails silently at runtime — the sender sends into a channel nobody listens
    // on and the recipe dies of a step timeout blaming the page. This is where it fails loudly.
    expect(declared('STEP_CHANNEL')).toBe(STEP_CHANNEL);
    expect(declared('RESULT_CHANNEL')).toBe(RESULT_CHANNEL);
  });

  it('are actually found by the matcher, not merely both absent', () => {
    // Without this, reformatting the declarations would make `declared()` return null for both
    // sides of a comparison it is not making — and the test above would still need to fail.
    expect(declared('STEP_CHANNEL')).not.toBeNull();
    expect(declared('RESULT_CHANNEL')).not.toBeNull();
    expect(declared('NO_SUCH_CHANNEL')).toBeNull();
  });
});
