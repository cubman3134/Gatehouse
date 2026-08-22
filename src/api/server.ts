import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { isLoopback, type GatehouseConfig } from '../config.js';
import { handleV1, type V1Deps } from './v1.js';
import { log } from '../log.js';

export class PortInUseError extends Error {}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Constant-time over equal-length inputs. The length check is not a leak worth defending
 * against — `timingSafeEqual` throws on unequal lengths, so it is a required precondition,
 * and the length of a bearer token is not the secret. What must not leak is *where* two
 * equal-length tokens first differ, and `timingSafeEqual` is what prevents that.
 */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, cfg: GatehouseConfig): boolean {
  // A loopback bind takes no auth: Allarr's FlareSolverr client sends no Authorization
  // header, and requiring one would break drop-in compatibility on day one.
  if (isLoopback(cfg.bind)) return true;
  if (cfg.token === null) return false;

  const header = req.headers.authorization ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return tokenMatches(header.slice(prefix.length), cfg.token);
}

export async function startServer(cfg: GatehouseConfig, deps: V1Deps, health: () => object): Promise<ServerHandle> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req, cfg)) { send(res, 401, { status: 'error', message: 'unauthorized' }); return; }

        const path = (req.url ?? '/').split('?')[0] ?? '/';

        if (path === '/gh/health') {
          if (req.method !== 'GET') { send(res, 405, { status: 'error', message: 'GET only' }); return; }
          send(res, 200, health());
          return;
        }

        if (path === '/v1') {
          if (req.method !== 'POST') { send(res, 405, { status: 'error', message: 'POST only' }); return; }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Deliberately the FlareSolverr error shape rather than a 400: any non-2xx is the
            // signal a FlareSolverr client already degrades on.
            send(res, 500, { status: 'error', message: 'request body was not valid JSON', startTimestamp: deps.now(), endTimestamp: deps.now(), version: deps.version });
            return;
          }
          const { httpStatus, body } = await handleV1(parsed, deps);
          send(res, httpStatus, body);
          return;
        }

        send(res, 404, { status: 'error', message: `no such path: ${path}` });
      } catch (e: unknown) {
        log.error('request failed', { message: e instanceof Error ? e.message : String(e) });
        if (!res.headersSent) send(res, 500, { status: 'error', message: 'internal error' });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new PortInUseError(
          `port ${cfg.port} on ${cfg.bind} is already in use. Port 8191 is FlareSolverr's own — ` +
            `if a real FlareSolverr is running, stop it or set GATEHOUSE_PORT to run both. ` +
            `Refusing to fall back to another port: the two are indistinguishable on the wire, ` +
            `so a silent move would leave it unclear which one your client is talking to.`,
        ));
        return;
      }
      reject(err);
    };
    const onListening = () => { server.removeListener('error', onError); resolve(); };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(cfg.port, cfg.bind);
  });

  const port = (server.address() as AddressInfo).port;
  log.info(`listening on http://${cfg.bind}:${port}`);

  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
