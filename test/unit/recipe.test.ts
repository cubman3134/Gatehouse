import { describe, it, expect } from 'vitest';
import {
  validateRecipe,
  isRecipeError,
  runRecipe,
  MAX_STEPS,
  type Recipe,
  type RecipeStep,
  type StepResult,
} from '../../src/downloads/recipe.js';

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

  it('accepts exactly MAX_STEPS', () => {
    // Rejection alone does not catch an off-by-one in the comparison.
    const steps = Array.from({ length: MAX_STEPS - 1 }, () => ({ op: 'waitFor', selector: 'a' }));
    steps.push({ op: 'readAttribute', selector: 'a', attribute: 'href' } as never);
    expect(isRecipeError(validateRecipe({ ...ok, steps }))).toBe(false);
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

// ---------------------------------------------------------------------------------------
// runRecipe. Pure apart from the injected `send`, so all of the sequencing — the budgets,
// the messages, the empty-value check — is reachable without an Electron runtime. The half
// that drives the DOM lives in the preload and is covered end to end.
// ---------------------------------------------------------------------------------------

/** A clock the test moves by hand: nothing here may depend on wall time. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Records what each step was sent, and answers from a script. */
function recorder(answers: (StepResult | (() => Promise<StepResult>))[]) {
  const sent: { step: RecipeStep; deadline: number }[] = [];
  let i = 0;
  const send = async (step: RecipeStep, deadline: number): Promise<StepResult> => {
    sent.push({ step, deadline });
    const a = answers[i++];
    if (a === undefined) throw new Error('send called more times than the test scripted');
    return typeof a === 'function' ? await a() : a;
  };
  return { sent, send };
}

const href = { ok: true as const, value: 'https://cdn.example.test/f.bin' };
const nothing = { ok: true as const, value: null };

describe('runRecipe', () => {
  it('runs the steps in order and returns the value the last one read', async () => {
    const c = clock();
    const r = recorder([nothing, nothing, href]);
    const out = await runRecipe(validateRecipe(ok) as Recipe, {
      send: r.send, stepMs: 5_000, totalMs: 30_000, now: c.now,
    });

    expect(out).toEqual({ url: 'https://cdn.example.test/f.bin' });
    expect(r.sent.map((s) => s.step.op)).toEqual(['click', 'waitFor', 'readAttribute']);
  });

  // The URL is returned RAW. The scheme gate is the caller's, and this test pins that
  // contract: a runRecipe that quietly refused a javascript: URL would hide the gate's
  // absence at the call site.
  it('returns the derived URL unvalidated', async () => {
    const c = clock();
    const r = recorder([nothing, nothing, { ok: true, value: 'javascript:alert(1)' }]);
    const out = await runRecipe(validateRecipe(ok) as Recipe, {
      send: r.send, stepMs: 5_000, totalMs: 30_000, now: c.now,
    });
    expect(out).toEqual({ url: 'javascript:alert(1)' });
  });

  it('names the step index and what it was looking for when a step fails', async () => {
    const c = clock();
    const r = recorder([nothing, { ok: false, error: 'matched nothing within the step timeout' }]);
    const out = await runRecipe(validateRecipe(ok) as Recipe, {
      send: r.send, stepMs: 5_000, totalMs: 30_000, now: c.now,
    });

    expect(isRecipeError(out)).toBe(true);
    if (isRecipeError(out)) {
      expect(out.message).toContain('step 1');
      expect(out.message).toContain('a[href*="/api/"]');       // the selector it was looking for
      expect(out.message).toContain('matched nothing within the step timeout');
    }
    expect(r.sent).toHaveLength(2); // and it stopped there
  });

  it('names the attribute on a readAttribute step and the text filter on a click', async () => {
    const c = clock();
    const bad = { ok: false as const, error: 'matched nothing within the step timeout' };

    const first = await runRecipe(validateRecipe(ok) as Recipe, {
      send: recorder([bad]).send, stepMs: 1, totalMs: 30_000, now: c.now,
    });
    expect(isRecipeError(first) && first.message).toContain('click button text="Download"');

    const last = await runRecipe(validateRecipe({ ...ok, steps: [ok.steps[2]] }) as Recipe, {
      send: recorder([bad]).send, stepMs: 1, totalMs: 30_000, now: c.now,
    });
    expect(isRecipeError(last) && last.message).toContain('a[href*="/api/"]@href');
  });

  it('gives up when the total budget is gone, naming the step it never got to', async () => {
    const c = clock();
    // Step 0 answers, but burns the whole budget doing it — to the millisecond, because
    // "no time left" is exactly no time left: a `>` here would send a step with a deadline
    // equal to the moment it was sent.
    const r = recorder([async () => { c.advance(30_000); return nothing; }, nothing, href]);
    const out = await runRecipe(validateRecipe(ok) as Recipe, {
      send: r.send, stepMs: 5_000, totalMs: 30_000, now: c.now,
    });

    expect(isRecipeError(out)).toBe(true);
    if (isRecipeError(out)) {
      expect(out.message).toMatch(/ran out of time at step 1/);
      expect(out.message).toContain('30000ms');
    }
    expect(r.sent).toHaveLength(1); // step 1 was never sent
  });

  // THE DEADLINE ARITHMETIC. A step near the end of the run must not be handed a deadline
  // past the overall one, or the page half polls on for a step budget after the recipe's
  // time is spent.
  it('hands each step the smaller of the step budget and what is left of the total', async () => {
    const c = clock(1_000); // overall deadline = 1_000 + 8_000 = 9_000
    const r = recorder([
      async () => { c.advance(4_000); return nothing; },  // t: 1_000 -> 5_000
      async () => { c.advance(1_000); return nothing; },  // t: 5_000 -> 6_000
      href,
    ]);
    const out = await runRecipe(validateRecipe(ok) as Recipe, {
      send: r.send, stepMs: 5_000, totalMs: 8_000, now: c.now,
    });

    expect(out).toEqual({ url: 'https://cdn.example.test/f.bin' });
    expect(r.sent.map((s) => s.deadline)).toEqual([
      6_000, // 1_000 + 5_000, the step budget: still inside the overall one
      9_000, // 5_000 + 5_000 would be 10_000; clamped to the overall deadline
      9_000, // 6_000 + 5_000 would be 11_000; clamped again
    ]);
  });

  it('reports an empty value against the step that read it', async () => {
    for (const value of [null, '']) {
      const c = clock();
      const r = recorder([nothing, nothing, { ok: true, value }]);
      const out = await runRecipe(validateRecipe(ok) as Recipe, {
        send: r.send, stepMs: 5_000, totalMs: 30_000, now: c.now,
      });

      expect(isRecipeError(out), JSON.stringify(value)).toBe(true);
      if (isRecipeError(out)) {
        expect(out.message).toContain('step 2');
        expect(out.message).toContain('read an empty value');
      }
    }
  });

  // A daemon: a rejection escaping here would land in a voided call site on the job path.
  it('turns a rejecting send into an error naming the step, and does not throw', async () => {
    const c = clock();
    const send = async (): Promise<StepResult> => { throw new Error('render frame was disposed'); };
    const out = await runRecipe(validateRecipe(ok) as Recipe, {
      send, stepMs: 5_000, totalMs: 30_000, now: c.now,
    });

    expect(isRecipeError(out)).toBe(true);
    if (isRecipeError(out)) {
      expect(out.message).toContain('step 0');
      expect(out.message).toContain('render frame was disposed');
    }
  });

  // Unreachable through validateRecipe, but the signature takes a Recipe and the message
  // builder would otherwise index step -1 and throw out of a function that promises a value.
  it('refuses an empty recipe instead of throwing', async () => {
    const c = clock();
    const out = await runRecipe({ startUrl: 'https://example.test/', steps: [] }, {
      send: async () => nothing, stepMs: 5_000, totalMs: 30_000, now: c.now,
    });
    expect(isRecipeError(out)).toBe(true);
  });
});
