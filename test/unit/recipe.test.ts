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
