import { describe, it, expect } from 'vitest';
import { classify, type PageSnapshot } from '../../src/browser/detect.js';

const snap = (over: Partial<PageSnapshot> = {}): PageSnapshot => ({
  status: 200,
  headers: {},
  html: '<html><body>hello</body></html>',
  ...over,
});

describe('classify', () => {
  it('calls an ordinary 200 clear', () => {
    expect(classify(snap())).toBe('clear');
  });

  it('calls a cf-mitigated response challenged', () => {
    expect(classify(snap({ status: 503, headers: { 'cf-mitigated': 'challenge' } }))).toBe('challenged');
  });

  it('is case-insensitive about header names', () => {
    expect(classify(snap({ status: 503, headers: { 'CF-Mitigated': 'challenge' } }))).toBe('challenged');
  });

  it('calls a challenge-form body challenged even on a 200', () => {
    expect(classify(snap({ html: '<div id="challenge-form"></div>' }))).toBe('challenged');
  });

  it('calls a turnstile body interactive', () => {
    expect(classify(snap({ status: 403, html: '<div class="cf-turnstile" data-sitekey="x"></div>' }))).toBe('interactive');
  });

  it('prefers interactive over challenged when both markers are present', () => {
    const html = '<div id="challenge-form"></div><div class="cf-turnstile"></div>';
    expect(classify(snap({ status: 503, html }))).toBe('interactive');
  });

  it('calls a 1020 body blocked, and blocked beats every other marker', () => {
    const html = '<div id="challenge-form"></div><div class="cf-turnstile"></div>error code: 1020';
    expect(classify(snap({ status: 403, html }))).toBe('blocked');
  });

  it('calls a 1015 rate-limit body blocked', () => {
    expect(classify(snap({ status: 429, html: 'Error 1015 Ray ID: abc' }))).toBe('blocked');
  });

  it('does not call a plain 403 from a non-Cloudflare host challenged', () => {
    expect(classify(snap({ status: 403, html: '<h1>Forbidden</h1>' }))).toBe('clear');
  });

  it.each([
    ['error code: 1020', 'blocked'],
    ['error 1020', 'blocked'],
    ['error code: 1015', 'blocked'],
    ['error 1015', 'blocked'],
    ['cf-turnstile', 'interactive'],
    ['challenges.cloudflare.com/turnstile', 'interactive'],
    ['challenge-form', 'challenged'],
    ['challenge-platform', 'challenged'],
    ['cf_chl_opt', 'challenged'],
  ])('exercises individual markers: "%s" → %s', (marker, expected) => {
    expect(classify(snap({ html: marker }))).toBe(expected);
  });
});
