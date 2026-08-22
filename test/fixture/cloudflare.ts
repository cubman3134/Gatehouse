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
   */
  mode?: 'js' | 'interactive';
}

function jsInterstitial(): string {
  return `<!doctype html><html><head><title>${CHALLENGE_TITLE}</title></head><body>
<div id="challenge-form"></div>
<p>Checking your browser before accessing the site.</p>
<script>setTimeout(function () { location.href = '/cdn-cgi/verify'; }, 250);</script>
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
  const secret = randomUUID();
  const paths: string[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    paths.push(path);

    // The verify hop mints the clearance cookie. Only a client that executed the
    // interstitial's script ever reaches it in 'js' mode; 'interactive' never links here.
    if (path === '/cdn-cgi/verify') {
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

    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cf-mitigated': 'challenge',
      'cache-control': 'no-store',
    });
    res.end(mode === 'js' ? jsInterstitial() : interactiveInterstitial());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    paths,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    ),
  };
}
