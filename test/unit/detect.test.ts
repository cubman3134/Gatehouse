import { describe, it, expect } from 'vitest';
import { classify, looksInteractive, type PageSnapshot } from '../../src/browser/detect.js';

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

  it('calls a turnstile body challenged, not terminal', () => {
    expect(classify(snap({ status: 403, html: '<div class="cf-turnstile" data-sitekey="x"></div>' }))).toBe('challenged');
  });

  it('keeps waiting when a turnstile widget sits beside the generic challenge markers', () => {
    const html = '<div id="challenge-form"></div><div class="cf-turnstile"></div>';
    expect(classify(snap({ status: 503, html }))).toBe('challenged');
  });

  /**
   * THE REGRESSION. This is the exact state a real managed challenge is in one second before
   * it clears itself, measured against hydralinks.cloud with no human present: a Turnstile
   * widget and the script host, alongside challenge-platform, on a 403 carrying cf-mitigated.
   * Judging it terminal aborted a solve that succeeded a second later. It must stay
   * `challenged` — i.e. keep polling.
   */
  /**
   * THE OTHER REGRESSION, measured against romhackplaza.org on 2026-08-23. A plain `curl` got
   * the real page with HTTP 200 and no challenge of any kind — and that page carried
   * `challenge-platform`, because Cloudflare injects it for INVISIBLE BOT MANAGEMENT on
   * ordinary pages, not only on interstitials.
   *
   * While it counted as a challenge marker, the solve loop polled this perfectly clear page
   * until its 70s deadline and then failed `challenge-failed` — on any Cloudflare-fronted site
   * using bot management, which is most of them.
   */
  it('calls a clean 200 carrying only challenge-platform CLEAR, not challenged', () => {
    const html = `<html><head><title>A normal page</title>
      <script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js"></script></head>
      <body><h1>real content</h1></body></html>`;

    expect(classify(snap({ status: 200, headers: {}, html }))).toBe('clear');
  });

  it('still calls it challenged when the authoritative header says so', () => {
    // The header is what actually distinguishes a challenge; the script tag never did.
    const html = '<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js"></script>';
    expect(classify(snap({ status: 403, headers: { 'cf-mitigated': 'challenge' }, html }))).toBe('challenged');
  });

  it('calls the real managed-challenge snapshot (turnstile + challenge-platform) challenged, never terminal', () => {
    const html = `<html><head>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head>
      <body><div id="challenge-platform"></div>
      <div class="cf-turnstile"></div>
      <script>window._cf_chl_opt={};</script>Just a moment...</body></html>`;
    const verdict = classify(snap({ status: 403, headers: { 'cf-mitigated': 'challenge' }, html }));

    expect(verdict).toBe('challenged');
    expect(verdict).not.toBe('blocked');
    // And the whole point: the poll loop's only terminal verdicts are clear and blocked, so
    // `challenged` here means the solve keeps waiting rather than failing at t=1s.
    expect(['clear', 'blocked']).not.toContain(verdict);
  });

  it('calls the t=0 managed snapshot — script host, no widget yet — challenged', () => {
    const html = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>';
    expect(classify(snap({ status: 403, html }))).toBe('challenged');
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
    ['cf-turnstile', 'challenged'],
    ['challenges.cloudflare.com/turnstile', 'challenged'],
    ['challenge-form', 'challenged'],
    // NOT challenged — see the regression test below and the note in detect.ts.
    ['challenge-platform', 'clear'],
    ['cf_chl_opt', 'challenged'],
  ])('exercises individual markers: "%s" → %s', (marker, expected) => {
    expect(classify(snap({ html: marker }))).toBe(expected);
  });
});

describe('looksInteractive', () => {
  it('is true for a turnstile widget container', () => {
    expect(looksInteractive(snap({ html: '<div class="cf-turnstile" data-sitekey="x"></div>' }))).toBe(true);
  });

  /**
   * The script host is injected on the ordinary invisible path and was present at t=0 on the
   * measured managed challenge that cleared itself two seconds later. It says nothing about
   * whether a person is needed, so it must not count here — if it did, every self-solving
   * challenge would be reported as needing a human the moment its deadline slipped.
   */
  it('is false for the turnstile script host alone', () => {
    const html = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>';
    expect(looksInteractive(snap({ html }))).toBe(false);
  });

  it('is false for a plain challenge interstitial', () => {
    expect(looksInteractive(snap({ html: '<div id="challenge-form"></div>' }))).toBe(false);
  });

  it('is false for a cleared page', () => {
    expect(looksInteractive(snap())).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(looksInteractive(snap({ html: '<div class="CF-Turnstile"></div>' }))).toBe(true);
  });

  it('does not fire on reCAPTCHA/hCaptcha markup — those are not Cloudflare', () => {
    expect(looksInteractive(snap({ html: '<div class="g-recaptcha" data-sitekey="x"></div>' }))).toBe(false);
  });
});
