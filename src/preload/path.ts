import { fileURLToPath } from 'node:url';

/**
 * The absolute path of the recipe preload, for `webPreferences.preload`.
 *
 * The preload is `src/preload/recipe.cjs` — hand-written CommonJS, never compiled (see the
 * comment at the top of that file for why it is not TypeScript). That leaves `dist/main.js`
 * having to locate a file `tsc` never emits, from a process whose working directory is
 * whatever launched it.
 *
 * **How:** relative to `import.meta.url`, never to `process.cwd()`. The launcher happens to
 * `cd /d` into the checkout, but nothing here may depend on that — a path built from the
 * working directory breaks the first time the app is started any other way.
 *
 * **Why no copy step into `dist/`:** `npm test` runs `tsc`, not `npm run build`, so a copy
 * that only happens on a full build would give the tree two states — one where this path
 * resolves and one where it does not — and the silent failure mode of a missing preload is
 * exactly the one worth designing out. Pointing at the source file instead leaves one state.
 * It also matches what `main.ts` already does for `../package.json`: the app runs from the
 * checkout, and `dist/` was never self-contained.
 *
 * The relative expression is deliberately one that resolves the same from `dist/preload/` and
 * from `src/preload/`, since both sit two levels under the repository root. That is what lets
 * `test/unit/preload.test.ts` — which loads this module as TypeScript, uncompiled — assert
 * that the file is really there and catch a rename or a move.
 */
export function recipePreloadPath(): string {
  return fileURLToPath(new URL('../../src/preload/recipe.cjs', import.meta.url));
}
