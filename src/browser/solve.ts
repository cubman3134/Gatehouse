import type { BrowserPool } from './pool.js';
import { classify, type PageSnapshot } from './detect.js';
import type { Solution, Solver, SolveRequest, SolvedCookie } from '../api/v1.js';
import type { FailureCode } from '../jobs/queue.js';
import { log } from '../log.js';

const POLL_INTERVAL_MS = 400;

/** A fixed literal. Page content is never interpolated into this. */
const GRAB_HTML = 'document.documentElement.outerHTML';

function coded(code: FailureCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeSolver(pool: BrowserPool): Solver {
  return async (req: SolveRequest): Promise<Solution> => {
    const win = await pool.acquire(req.session);
    const wc = win.webContents;
    const ses = wc.session;

    // Main-frame response status and headers, captured as they arrive.
    let status = 0;
    let headers: Record<string, string> = {};
    const onHeaders = (
      details: Electron.OnHeadersReceivedListenerDetails,
      cb: (r: Electron.HeadersReceivedResponse) => void,
    ) => {
      if (details.resourceType === 'mainFrame') {
        status = details.statusCode;
        headers = Object.fromEntries(
          Object.entries(details.responseHeaders ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            Array.isArray(v) ? v.join(', ') : String(v),
          ]),
        );
      }
      cb({});
    };
    ses.webRequest.onHeadersReceived(onHeaders);

    const deadline = Date.now() + req.maxTimeout;

    try {
      if (req.postData !== undefined) {
        await wc.loadURL(req.url, {
          postData: [{ type: 'rawData', bytes: Buffer.from(req.postData, 'utf8') }],
          extraHeaders: 'Content-Type: application/x-www-form-urlencoded',
        });
      } else {
        await wc.loadURL(req.url);
      }

      let verdict = 'challenged' as ReturnType<typeof classify>;
      let html = '';

      while (Date.now() < deadline) {
        html = (await wc.executeJavaScript(GRAB_HTML, true)) as string;
        const snap: PageSnapshot = { status, headers, html };
        verdict = classify(snap);

        if (verdict === 'clear') break;
        if (verdict === 'blocked') {
          throw coded('blocked', `host returned a hard block for ${req.url}`);
        }
        if (verdict === 'interactive') {
          // SEAM FOR INCREMENT 3: this is where the job becomes `pending-human` and the
          // window is shown. Until then an interactive challenge is a clean failure.
          throw coded(
            'challenge-failed',
            `${req.url} needs an interactive challenge solved; not supported yet`,
          );
        }
        await sleep(POLL_INTERVAL_MS);
      }

      if (verdict !== 'clear') {
        throw coded('challenge-failed', `challenge did not clear within ${req.maxTimeout}ms for ${req.url}`);
      }

      const finalUrl = wc.getURL();
      const raw = await ses.cookies.get({ url: finalUrl });
      const cookies: SolvedCookie[] = raw.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? '',
        path: c.path ?? '/',
        expires: c.expirationDate ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
      }));

      log.info('solved', { url: req.url, session: req.session, status, cookies: cookies.length });

      return { url: finalUrl, status, headers, cookies, userAgent: wc.getUserAgent(), response: html };
    } catch (e: unknown) {
      if (wc.isDestroyed()) throw coded('browser-crashed', 'the browser window died mid-solve');
      throw e;
    } finally {
      ses.webRequest.onHeadersReceived(null);
      pool.release(win);
    }
  };
}
