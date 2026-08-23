export interface PageSnapshot {
  /** HTTP status code. Carried for the caller's benefit; verdict MUST NOT depend on it.
   * A bare 403 with no Cloudflare marker is an ordinary site refusal and must stay `clear`. */
  status: number;
  headers: Record<string, string>;
  html: string;
}

/**
 * There is deliberately no `interactive` verdict.
 *
 * A Turnstile widget in the markup does not mean a person is needed. Cloudflare's *managed*
 * challenge renders a Turnstile invisibly and solves it itself, so the widget is present
 * during a challenge that is about to clear on its own. Measured against a real challenged
 * host (hydralinks.cloud, 2026-08-22), one snapshot a second, no human present:
 *
 *   t=0ms    403 cf-mitigated=challenge  challenges.cloudflare.com/turnstile, challenge-platform, cf_chl_opt
 *   t=1000ms 403 cf-mitigated=challenge  cf-turnstile, challenges.cloudflare.com/turnstile, challenge-platform
 *   t=2000ms 200 cf-mitigated=-          no markers, cf_clearance issued
 *
 * Treating the marker at t=1000ms as terminal aborted a solve that succeeded 1s later. So
 * "does this need a person?" is not something one snapshot can answer — it is a judgement
 * made only when the deadline expires without clearing, from `looksInteractive` below.
 */
export type Verdict = 'clear' | 'challenged' | 'blocked';

/** Cloudflare's terminal codes. Retrying these makes a soft block permanent. */
const BLOCK_MARKERS = ['error code: 1020', 'error 1020', 'error code: 1015', 'error 1015'] as const;
/**
 * Cloudflare challenge interstitial markers — every one of these means "keep waiting",
 * including the Turnstile ones (see the note on `Verdict`).
 *
 * **Removed, each because it appears on pages that are not challenged at all:**
 *
 * - `just a moment` — ordinary English; matches copy like "Just a moment, loading your cart".
 * - `challenge-platform` — **measured on a live HTTP 200 page with no challenge involved**
 *   (romhackplaza.org, 2026-08-23: plain `curl` got the real page, and it carried this).
 *   Cloudflare injects `/cdn-cgi/challenge-platform/...` for *invisible bot management* on
 *   ordinary pages, not only on interstitials. Treating it as a challenge made the solve loop
 *   poll a perfectly clear page until its deadline and then fail — on any Cloudflare-fronted
 *   site using bot management, which is most of them.
 *
 * What is left is interstitial-specific: `cf_chl_opt` is the challenge options object and
 * `challenge-form` is the interstitial's own form. The authoritative signal is the
 * `cf-mitigated: challenge` header, checked before this list.
 *
 * **Known residual risk, not yet measured:** the two Turnstile markers have the same shape of
 * problem — a *cleared* page carrying a Turnstile widget on a login or comment form would be
 * read as challenged and poll to the deadline. They are kept because no such page has been
 * measured, and because dropping them risks calling a real interstitial clear. If a site is
 * ever seen hanging with a Turnstile widget on a 200, this is the first place to look.
 */
const CHALLENGE_MARKERS = [
  'challenge-form',
  'cf_chl_opt',
  'cf-turnstile',
  'challenges.cloudflare.com/turnstile',
] as const;

/**
 * The Turnstile *widget container*. Only this one counts as a hint that a person may be
 * needed.
 *
 * `challenges.cloudflare.com/turnstile` is deliberately NOT in this list: it is the script
 * host Cloudflare injects on the ordinary invisible path, present from t=0 on every managed
 * challenge (see the measurement on `Verdict`), so it carries no signal at all about whether
 * a human is required. Adding it back makes every self-solving challenge look interactive.
 * `data-sitekey` is not here either — that is reCAPTCHA/hCaptcha, not Cloudflare.
 */
const INTERACTIVE_MARKERS = ['cf-turnstile'] as const;

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/**
 * Classify one page snapshot. Order matters: a blocked page often still carries challenge
 * markup, so the most specific verdict has to win.
 *
 * A bare 403 with no Cloudflare marker is deliberately `clear` — it is somebody else's 403,
 * and treating it as a challenge would make the solve loop spin until its deadline on a page
 * that is never going to change.
 */
export function classify(snap: PageSnapshot): Verdict {
  const html = snap.html.toLowerCase();

  if (BLOCK_MARKERS.some((m) => html.includes(m))) return 'blocked';

  const mitigated = header(snap.headers, 'cf-mitigated');
  if (mitigated !== undefined && mitigated.toLowerCase().trim() === 'challenge') return 'challenged';

  if (CHALLENGE_MARKERS.some((m) => html.includes(m))) return 'challenged';

  return 'clear';
}

/**
 * Does this snapshot look like a challenge a person has to finish?
 *
 * This is a *hint*, not a verdict, and it is only meaningful on the last snapshot of a solve
 * that ran out of deadline: a managed challenge shows the same widget while solving itself.
 * A caller that consults it mid-poll reproduces the bug this predicate was split out to fix.
 */
export function looksInteractive(snap: PageSnapshot): boolean {
  const html = snap.html.toLowerCase();
  return INTERACTIVE_MARKERS.some((m) => html.includes(m));
}
