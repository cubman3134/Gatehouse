export interface PageSnapshot {
  /** HTTP status code. Carried for the caller's benefit; verdict MUST NOT depend on it.
   * A bare 403 with no Cloudflare marker is an ordinary site refusal and must stay `clear`. */
  status: number;
  headers: Record<string, string>;
  html: string;
}

export type Verdict = 'clear' | 'challenged' | 'interactive' | 'blocked';

/** Cloudflare's terminal codes. Retrying these makes a soft block permanent. */
const BLOCK_MARKERS = ['error code: 1020', 'error 1020', 'error code: 1015', 'error 1015'] as const;
/** Cloudflare-scoped widget markers. `data-sitekey` is reCAPTCHA/hCaptcha, not Cloudflare. */
const INTERACTIVE_MARKERS = ['cf-turnstile', 'challenges.cloudflare.com/turnstile'] as const;
/** Cloudflare challenge interstitial markers. Removed: 'just a moment' (too generic,
 * appears in cleared pages like "Just a moment, loading your cart"; covered by
 * challenge-form, challenge-platform, cf_chl_opt, and cf-mitigated header). */
const CHALLENGE_MARKERS = ['challenge-form', 'challenge-platform', 'cf_chl_opt'] as const;

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/**
 * Classify one page snapshot. Order matters: a blocked page often still carries challenge
 * markup, and an interactive challenge always carries the generic challenge markers too, so
 * the most specific verdict has to win.
 *
 * A bare 403 with no Cloudflare marker is deliberately `clear` — it is somebody else's 403,
 * and treating it as a challenge would make the solve loop spin until its deadline on a page
 * that is never going to change.
 */
export function classify(snap: PageSnapshot): Verdict {
  const html = snap.html.toLowerCase();

  if (BLOCK_MARKERS.some((m) => html.includes(m))) return 'blocked';
  if (INTERACTIVE_MARKERS.some((m) => html.includes(m))) return 'interactive';

  const mitigated = header(snap.headers, 'cf-mitigated');
  if (mitigated !== undefined && mitigated.toLowerCase().trim() === 'challenge') return 'challenged';

  if (CHALLENGE_MARKERS.some((m) => html.includes(m))) return 'challenged';

  return 'clear';
}
