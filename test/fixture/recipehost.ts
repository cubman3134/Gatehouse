import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A host that mints its download URL only after a click.
 *
 * This is the shape the recipe feature exists for, reduced to the part that matters: a page
 * with a button, and a link that does not exist in the markup the first request returns. A
 * plain `POST /gh/fetch` of the page URL against this host downloads the *page*; only driving
 * it gets the file.
 *
 * The modes are the four endings the engine has to tell apart:
 *
 * - `reveal`  — the measured flow. The click reveals `<a href="/file.bin">` after a delay, and
 *               the recipe reads its `href`.
 * - `direct`  — the click starts the download itself and no link ever appears. The recipe's
 *               remaining steps can never succeed, and must not need to: the item that arrives
 *               mid-recipe IS the result.
 * - `hostile` — the revealed link points at `file:///C:/Windows/win.ini`. A derived URL is
 *               site-controlled input, and this is what the scheme gate is for.
 * - `never`   — the button is there and nothing is ever revealed. The step timeout is the only
 *               thing that ends this.
 * - `duringLoad` — the download starts **while the page is still loading**, with no click at
 *               all. This is the only mode that lands before `loadURL` resolves, which is what
 *               makes it the one that can see the handler-ordering rule. See below.
 *
 * The delay is deliberate rather than incidental: a link that appears synchronously inside the
 * click would let a `waitFor` that never polls pass anyway.
 */
export type RecipeHostMode = 'reveal' | 'direct' | 'hostile' | 'never' | 'duringLoad';

export interface RecipeHost {
  /** The page a recipe starts at. */
  url: string;
  /** The file the page leads to, for an independent fetch or a negative assertion. */
  fileUrl: string;
  close(): Promise<void>;
}

export interface RecipeHostOptions {
  mode?: RecipeHostMode;
  body?: Buffer;
  filename?: string;
  /** How long after the click the link appears. Long enough to need a poll, short enough to test. */
  revealMs?: number;
}

/** The absolute local path the `hostile` mode points its link at. Never fetched — that is the point. */
export const HOSTILE_HREF = 'file:///C:/Windows/win.ini';

/**
 * The page, per mode.
 *
 * The script is a fixed literal — this fixture builds no markup out of anything a caller sent,
 * for the same reason the engine builds no script out of a selector.
 */
function page(mode: RecipeHostMode, revealMs: number): string {
  /**
   * `duringLoad`: a subframe navigation to the `attachment` response, issued as part of the
   * document's own load.
   *
   * **Four mechanisms were measured; only this one is in the right place in time.** What the
   * mode has to do is start the download *strictly before `wc.loadURL()` resolves*, because
   * that is the only window in which "attached before the navigation" and "attached after it"
   * differ at all. Against the real app:
   *
   * | mechanism | correct code | `will-download` attached after `loadURL` |
   * |---|---|---|
   * | `Content-Disposition: attachment` on `startUrl` | **fails** — `loadURL` rejects `ERR_FAILED (-2)` | fails the same way |
   * | `<meta http-equiv="refresh" content="0;…">` | done, 170ms | done — still caught |
   * | `location.href` on `DOMContentLoaded` | done, 156ms | done — still caught |
   * | `location.href` at parse time | done, 168ms | done — still caught |
   * | `<iframe src="/file.bin">` (this one) | done, 170ms | **fails**, 2.2s |
   *
   * A top-level navigation to a download does not abort the page load — Chromium leaves the
   * document alone and turns the request into an item — but it also lands *after* the load
   * finishes, so a late attach catches all three of those. Serving the attachment as `startUrl`
   * itself is the opposite failure: the navigation never commits, `loadURL` rejects, and the
   * recipe fails for a reason that has nothing to do with the handler.
   *
   * A subframe load is part of the parent's load. The item exists before `did-finish-load`, so
   * a handler attached after `loadURL` is genuinely too late for it — which is exactly the
   * measured production hazard: an unclaimed item raises a native modal Save As dialog on a
   * daemon with no one to click it.
   */
  if (mode === 'duringLoad') {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>recipe fixture (duringLoad)</title></head>
<body>
  <p id="slot"></p>
  <button id="go">Download</button>
  <iframe src="/file.bin" hidden></iframe>
</body></html>`;
  }

  const reveal = (href: string): string =>
    `setTimeout(function () {
       var a = document.createElement('a');
       a.id = 'link';
       a.setAttribute('href', ${JSON.stringify(href)});
       a.textContent = 'get the file';
       document.getElementById('slot').appendChild(a);
     }, ${revealMs});`;

  const onClick =
    mode === 'reveal' ? reveal('/file.bin')
    : mode === 'hostile' ? reveal(HOSTILE_HREF)
    // A navigation to a `Content-Disposition: attachment` response is a download, started by
    // the page itself. No link is ever added to the document.
    : mode === 'direct' ? `setTimeout(function () { window.location.href = '/file.bin'; }, ${revealMs});`
    : '/* never: the click is observed and nothing follows it */';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>recipe fixture (${mode})</title></head>
<body>
  <p id="slot"></p>
  <button id="go">Download</button>
  <script>
    document.getElementById('go').addEventListener('click', function () {
      ${onClick}
    });
  </script>
</body></html>`;
}

export async function startRecipeHost(opts: RecipeHostOptions = {}): Promise<RecipeHost> {
  const mode = opts.mode ?? 'reveal';
  const body = opts.body ?? Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const filename = opts.filename ?? 'recipe.bin';
  const revealMs = opts.revealMs ?? 300;
  const html = Buffer.from(page(mode, revealMs), 'utf8');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/file.bin') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        // What makes `direct`'s navigation a download rather than a render.
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
      });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(html.length),
    });
    res.end(html);
  });

  // The page holds a keep-alive socket for as long as the window is open, and `close()` waits
  // for every connection to end on its own. Hold them so close() can cut them.
  const sockets = new Set<Socket>();
  server.on('connection', (s: Socket) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/page`,
    fileUrl: `${origin}/file.bin`,
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      for (const s of sockets) s.destroy();
    }),
  };
}
