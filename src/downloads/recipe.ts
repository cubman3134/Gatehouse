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
