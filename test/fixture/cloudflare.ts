import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export const PAYLOAD_MARKER = 'gatehouse-protected-payload';
export const CHALLENGE_TITLE = 'Just a moment...';

export interface Fixture {
  /** Base URL, e.g. http://127.0.0.1:53421 */
  url: string;
  /** The cf_clearance value this instance will accept. */
  secret: string;
  /** Every path the fixture was asked for, in order. */
  paths: string[];
  close(): Promise<void>;
}

export interface FixtureOptions {
  /**
   * 'js'          — the interstitial auto-solves via a script (a real browser clears it).
   * 'interactive' — the interstitial needs a human click and has no auto-verify path.
   * 'managed'     — Cloudflare's *managed* challenge as measured in the wild: a Turnstile
   *                 widget appears while the page is still challenged, and then the page
   *                 solves itself with no human involved. This is the case Gatehouse exists
   *                 for, and the one an "interactive == turnstile present" reading breaks.
   */
  mode?: 'js' | 'interactive' | 'managed';
  /** 'managed' only: how long the interstitial waits before solving itself. */
  managedSolveDelayMs?: number;
}

function jsInterstitial(): string {
  return `<!doctype html><html><head><title>${CHALLENGE_TITLE}</title></head><body>
<div id="challenge-form"></div>
<p>Checking your browser before accessing the site.</p>
<script>setTimeout(function () { location.href = '/cdn-cgi/verify'; }, 250);</script>
</body></html>`;
}

/**
 * Reproduces the measured real-world timeline (hydralinks.cloud, 2026-08-22, one snapshot a
 * second, no human present):
 *
 *   t=0     challenged, script host + challenge-platform + cf_chl_opt, no widget yet
 *   t≈1000  challenged, and now a Turnstile widget too
 *   t≈2000  cleared on its own, cf_clearance issued
 *
 * The widget is appended by script rather than served in the markup, so the widget marker is
 * genuinely absent from the first snapshots — and for that to hold, the literal marker must
 * not appear anywhere in the served source, hence the split string below.
 */
function managedInterstitial(solveDelayMs: number): string {
  const widgetAt = Math.max(0, Math.round(solveDelayMs * 0.35));
  // The script host is recorded as text rather than as a real <script src>: the marker has to
  // be in the DOM from t=0, but a test suite must not reach out to cloudflare.com to get it.
  return `<!doctype html><html><head><title>${CHALLENGE_TITLE}</title>
<script>window.__cfChlScript = 'https://challenges.cloudflare.com/turnstile/v0/api.js';</script>
</head><body>
<div id="challenge-platform"></div>
<script>window._cf_chl_opt = { cvId: '3' };</script>
<p>Checking your browser before accessing the site.</p>
<script>
setTimeout(function () {
  var d = document.createElement('div');
  d.className = 'cf-' + 'turnstile';
  document.body.appendChild(d);
}, ${widgetAt});
setTimeout(function () { location.href = '/cdn-cgi/verify'; }, ${solveDelayMs});
</script>
</body></html>`;
}

function interactiveInterstitial(): string {
  return `<!doctype html><html><head><title>${CHALLENGE_TITLE}</title></head><body>
<div id="challenge-form"></div>
<div class="cf-turnstile" data-sitekey="0x0000000000000000"></div>
<p>Verify you are human by completing the action below.</p>
</body></html>`;
}

function protectedPage(): string {
  return `<!doctype html><html><head><title>Protected</title></head><body>
<h1>${PAYLOAD_MARKER}</h1><p id="payload">ok</p>
</body></html>`;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export async function startCloudflareFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const mode = opts.mode ?? 'js';
  const managedSolveDelayMs = opts.managedSolveDelayMs ?? 1100;
  const secret = randomUUID();
  const paths: string[] = [];

  let closed = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    paths.push(path);

    // The verify endpoint exists in the self-solving modes ('js', 'managed') and mints the
    // clearance cookie when reached. In 'interactive' mode, the endpoint does not exist.
    if (path === '/cdn-cgi/verify' && mode !== 'interactive') {
      res.writeHead(302, {
        'set-cookie': `cf_clearance=${secret}; Path=/; HttpOnly`,
        location: '/',
      });
      res.end();
      return;
    }

    if (cookieValue(req, 'cf_clearance') === secret) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(protectedPage());
      return;
    }

    // 403 for 'managed', matching what the real challenged host answered with.
    res.writeHead(mode === 'managed' ? 403 : 503, {
      'content-type': 'text/html; charset=utf-8',
      'cf-mitigated': 'challenge',
      'cache-control': 'no-store',
    });
    if (mode === 'managed') {
      res.end(managedInterstitial(managedSolveDelayMs));
    } else {
      res.end(mode === 'js' ? jsInterstitial() : interactiveInterstitial());
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    paths,
    close: () => new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      server.close(() => {
        closed = true;
        resolve();
      });
    }),
  };
}
