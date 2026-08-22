import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { ConfigError, isLoopback, type GatehouseConfig } from '../config.js';
import { fail, handleV1, type V1Deps } from './v1.js';
import { log } from '../log.js';

export class PortInUseError extends Error {}

export interface ServerHandle {
  port: number;
  /**
   * Exposed so a test can drive server-level events (an accept-time `error`, say) that no
   * HTTP request can produce. Nothing in production reaches for it.
   */
  server: Server;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * How much of an over-long body we are willing to read and throw away after answering, purely
 * so the connection can close cleanly. A courtesy, not an obligation — nothing is buffered.
 */
const MAX_DRAIN_BYTES = 8_000_000;

/**
 * Resolves rather than rejects on overflow: the caller has to answer with a real 500 before
 * the socket goes away, and rejecting invited the old shape where `req.destroy()` ran on the
 * same tick and the client saw `ECONNRESET` instead of the error body.
 */
type Body = { tooLarge: true } | { tooLarge: false; text: string };

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { settle(() => resolve({ tooLarge: true })); return; }
      chunks.push(c);
    });
    req.on('end', () => settle(() => resolve({ tooLarge: false, text: Buffer.concat(chunks).toString('utf8') })));
    req.on('error', (e) => settle(() => reject(e)));
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

function authorized(req: IncomingMessage, cfg: GatehouseConfig, loopback: boolean): boolean {
  // A loopback bind takes no auth: Allarr's FlareSolverr client sends no Authorization
  // header, and requiring one would break drop-in compatibility on day one.
  //
  // `loopback` is the verdict on the address `listen` ACTUALLY bound, not on `cfg.bind`. A
  // name like `localhost` goes through DNS/hosts and need not land on 127.0.0.1; exempting on
  // the string would then hand an unauthenticated driver to whatever it did resolve to — and
  // a configured token would never be consulted, so it would not save us.
  if (loopback) return true;
  // Falsy, not `=== null`: an empty token would sail through and `timingSafeEqual` returns
  // true for two empty buffers, so `Authorization: Bearer ` would authenticate. This branch
  // exists so the gate does not depend on `loadConfig` having rejected that first.
  if (!cfg.token) return false;

  const header = req.headers.authorization ?? '';
  const prefix = 'Bearer ';
  // RFC 7235 makes the auth-scheme token case-insensitive; the credential after it is not.
  if (header.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return false;
  return tokenMatches(header.slice(prefix.length), cfg.token);
}

/**
 * Loopback for a *resolved* address, which is a narrower question than `isLoopback(bind)`:
 * no names, and the whole of 127/8 rather than one literal.
 */
function boundToLoopback(address: string): boolean {
  const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return addr === '::1' || /^127\./.test(addr);
}

export async function startServer(cfg: GatehouseConfig, deps: V1Deps, health: () => object): Promise<ServerHandle> {
  // Seeded from the configured name, then replaced below with the verdict on the address that
  // was actually bound. Nothing can be served before `listen` resolves, so the seed value is
  // never the one a request is judged against.
  let loopback = isLoopback(cfg.bind);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req, cfg, loopback)) { send(res, 401, { status: 'error', message: 'unauthorized' }); return; }

        const path = (req.url ?? '/').split('?')[0] ?? '/';

        if (path === '/gh/health') {
          // HEAD is GET without a body — a monitoring probe that sends one is not making a
          // bad request. Node suppresses the body for HEAD on its own.
          if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { status: 'error', message: 'GET only' }); return; }
          send(res, 200, health());
          return;
        }

        if (path === '/v1') {
          if (req.method !== 'POST') { send(res, 405, { status: 'error', message: 'POST only' }); return; }
          const read = await readBody(req);
          if (read.tooLarge) {
            // Answer first, hang up second — and the hang-up has to be an orderly one.
            // Destroying the socket while the client is still uploading closes it with unread
            // inbound data, which makes the OS send RST rather than FIN, and an RST discards
            // the response still sitting in the client's receive buffer: it observes
            // ECONNRESET, i.e. "solver unavailable", instead of the 500 we just wrote.
            // (Measured — the destroy-on-finish shape fails this way every time.)
            //
            // So: stop buffering, write the reply, then drain a bounded remainder so the
            // close is a FIN. Only a client that keeps pushing past that gets cut off, and by
            // then it has long since had its 500.
            req.pause();
            res.on('finish', () => {
              let drained = 0;
              req.on('data', (c: Buffer) => {
                drained += c.length;
                // setImmediate, NOT a same-tick destroy: `finish` means "handed to the
                // socket", not "transmitted", and an RST discards the sender's unflushed
                // buffer too. Destroying in the same turn as the crossing chunk loses the
                // 500 we just wrote (measured: same-tick 3/3 reset, next-turn 3/3 delivered).
                if (drained > MAX_DRAIN_BYTES) setImmediate(() => req.destroy());
              });
              req.resume();
            });
            const tooLarge = fail(deps, deps.now(), `request body exceeds ${MAX_BODY_BYTES} bytes`);
            send(res, tooLarge.httpStatus, tooLarge.body);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(read.text);
          } catch {
            // Deliberately the FlareSolverr error shape rather than a 400: any non-2xx is the
            // signal a FlareSolverr client already degrades on. Built by v1's own `fail` so the
            // two cannot drift.
            const bad = fail(deps, deps.now(), 'request body was not valid JSON');
            send(res, bad.httpStatus, bad.body);
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
        const flareSolverr = cfg.port === 8191
          ? `Port 8191 is FlareSolverr's own — if a real FlareSolverr is running, stop it or ` +
            `set GATEHOUSE_PORT to run both. `
          : '';
        reject(new PortInUseError(
          `port ${cfg.port} on ${cfg.bind} is already in use. ${flareSolverr}` +
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

  // `onError` is gone and this is a daemon: a `net.Server` with no `error` listener throws on
  // the next accept-time failure (EMFILE/ENFILE are realistic for a process that also spawns
  // browsers) and takes the process with it. Log it and stay up.
  server.on('error', (e: Error) => log.error('server error', { message: e.message }));

  const address = server.address() as AddressInfo;
  const port = address.port;

  // The auth gate exempts loopback on the strength of `cfg.bind`, a string. What is actually
  // reachable is what `listen` bound — `localhost` goes through DNS/hosts and need not land
  // on 127.0.0.1. If they disagree and there is no token, nothing is guarding the door.
  loopback = boundToLoopback(address.address);

  if (!loopback && !cfg.token) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new ConfigError(
      `GATEHOUSE_BIND=${cfg.bind} resolved to ${address.address}, which is reachable off-box, ` +
        `and no GATEHOUSE_TOKEN is set. Refusing to serve an unauthenticated browser driver: ` +
        `the loopback exemption applies to the address actually bound, not the name asked for.`,
    );
  }

  log.info(`listening on http://${cfg.bind}:${port}`);

  return {
    port,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
