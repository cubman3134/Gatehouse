# Gatehouse

A browser-backed solver-proxy. It drives a real Chromium through Cloudflare's
*non-interactive* JS challenge, holds persistent per-site sessions, and answers
FlareSolverr's `/v1` protocol so an existing FlareSolverr client needs no changes —
point its `FlareSolverrUrl` at Gatehouse and stop the old daemon.

It is **not** a CAPTCHA bypass and must never become one. The non-interactive
challenge clears simply by being a real browser. No solving service, no token
purchase, no bot-detection evasion beyond being an ordinary browser. An interactive
challenge is refused in this increment; a later one hands it to a person to solve
once.

See [the design](docs/superpowers/specs/2026-08-22-gatehouse-design.md).

## What is actually proven

Increment 1 has **never been run against a live Cloudflare-protected site.** Every
test here runs against a fake Cloudflare in `test/fixture/` — a local HTTP server
that serves a `503` + `cf-mitigated: challenge` interstitial until a `cf_clearance`
cookie is presented. That fixture proves the *mechanism* (a real browser clears a JS
interstitial, the cookie is captured, the wire shape matches). It cannot prove the
*premise*, because real Cloudflare fingerprints far more than the fixture does.

So: treat "works against real Cloudflare" as unverified. The remaining acceptance is
a manual run against a real client and a real protected host.

## Requirements

- **Node >= 22.12.0** — Electron 43 requires it. `package.json` declares the floor, so a
  lower Node produces an `EBADENGINE` warning on install and an Electron that will not run.
- A desktop session. The integration tests spawn a real Electron; a headless Linux CI
  leg would need `xvfb-run`. Increment 1 is Windows-first and that is not solved here.

### The Electron binary is not downloaded by `npm ci`

Electron is pinned at `43.4.1` and the package ships **no `postinstall` script**, so a
fresh `npm ci` or `npm install` leaves you with `node_modules/electron` containing no
browser — about 235 MB of download that has not happened yet. This is the first thing
that will confuse you.

It is fetched lazily, the first time anything calls `require('electron')` — i.e. on
your first `npm start` or your first integration-test run, which prints
`Downloading Electron binary...` and then stalls for as long as the download takes.
The integration harness gives the app 30 seconds to report ready, so a first test run
on a cold `node_modules` can fail on the download rather than on anything real.

Fetch it up front instead:

```
node node_modules/electron/install.js
```

## Run

```
npm install
node node_modules/electron/install.js   # once, see above
npm run build
npm start
```

`npm start` is `electron .`, and `package.json` points `main` at `dist/main.js` — so
it runs whatever `npm run build` last compiled, not your sources. Rebuild after edits.

On success it prints one line to stdout:

```
GATEHOUSE_READY http://127.0.0.1:8191
```

8191 is FlareSolverr's own port, so an existing `FlareSolverrUrl` setting needs no
edit. If the port is taken, startup **fails** saying so rather than moving to another
port — the two daemons are indistinguishable on the wire, so a silent move would leave
it unclear which one your client reached. Stop the real FlareSolverr, or set
`GATEHOUSE_PORT` and run both.

## Settings

All configuration is environment variables; there is no config file.

| Variable | Default | Meaning |
|---|---|---|
| `GATEHOUSE_PORT` | `8191` | Listen port. `0` picks a free one (used by the tests). |
| `GATEHOUSE_BIND` | `127.0.0.1` | Bind address. Non-loopback requires a token. |
| `GATEHOUSE_TOKEN` | *(none)* | Bearer token. Mandatory for a non-loopback bind. |
| `GATEHOUSE_CONCURRENCY` | `2` | Simultaneous browser windows, 1–16. |
| `GATEHOUSE_SOLVE_TIMEOUT_MS` | `70000` | Server-side ceiling on one solve, 1000–600000 — but see below: anything above 300000 is inert. |

A bad value is a startup failure with the range in the message, not a silent fallback.

**Auth.** A loopback bind takes no auth, because FlareSolverr clients send no
`Authorization` header and requiring one would break drop-in compatibility on day one.
Binding anywhere else without `GATEHOUSE_TOKEN` is refused at startup rather than
silently exposing a browser driver to the network. The loopback exemption is decided
on the address that was actually bound, not on the string you configured — `localhost`
resolves through DNS and need not land on `127.0.0.1`.

**`GATEHOUSE_SOLVE_TIMEOUT_MS` is a ceiling, not a deadline.** The client supplies
`maxTimeout` per request; the effective deadline is `min(maxTimeout, this)`. It exists
so an operator can cap a client that asks for more time than the machine should spend.
The default 70000 matches what a typical client sends, so by default it changes nothing.

## API

### `POST /v1` — the FlareSolverr compatibility surface

`request.get`, `request.post`, `sessions.create`, `sessions.list`, `sessions.destroy`.
The response shape is FlareSolverr's and is not ours to redesign. A client typically
reads exactly two things out of a success: `solution.userAgent`, and the entry in
`solution.cookies` whose `name` is `cf_clearance`. Everything else is there for
compatibility with other callers.

**Every rejection of a well-formed POST is an HTTP 500 carrying the FlareSolverr error body**
(`{"status":"error","message":…}`) — never a 400, never a 200 with an error inside.
That is deliberate: a FlareSolverr client already degrades on any non-2xx, and a
malformed request that came back 200 would be read as a success with no clearance
cookie and no way to tell why. Bad JSON, an over-long body, an unknown command and a
failed solve all take the same route. (A request that is not a well-formed POST is
answered earlier and differently: an unauthenticated request on a non-loopback bind gets
`401`, and a non-POST to `/v1` gets `405`.)

There are **two** ceilings on a solve, and the effective deadline is the smaller of three
numbers: `min(the client's maxTimeout, 300000, GATEHOUSE_SOLVE_TIMEOUT_MS)`. The `300000`
is a fixed cap applied to the client-supplied value before the operator ceiling is
consulted, so setting `GATEHOUSE_SOLVE_TIMEOUT_MS` above 300000 has no effect — the
config layer accepts it up to 600000 without complaining, which is a wart worth knowing
about rather than a feature.

Two inputs are validated more strictly than FlareSolverr validates them:

- **`url` must be `http:` or `https:`.** This is a deliberate deviation. The URL is
  handed to a real browser; without an allow-list, a `file:` URL turns this service
  into an arbitrary local-file reader that answers over the wire.
- **A caller-supplied `session` must match `/^[A-Za-z0-9._-]{1,64}$/`** and not be all
  dots. A session name becomes a Chromium partition and from there a directory on disk,
  so it is restricted to characters that cannot walk out of it. A session *derived* from
  the URL's hostname is sanitized instead of rejected — the caller did not choose it.

### `GET /gh/health`

Version, browser-pool `busy`/`total`, and queue depth. `HEAD` works too.

## Test

```
npm run test:unit         # fast, no Electron
npm run test:integration  # builds, then spawns the real app
npm test                  # builds, then everything
```

`npm test` and `npm run test:integration` compile first, on purpose. The integration
harness spawns `electron .` against the compiled `dist/`, so running `vitest` directly
after an edit would test the *previously* compiled code and pass while your change is
not in it. The harness also refuses to run if `dist/` is missing or older than `src/`,
which catches that case rather than reporting a green suite.

`test/integration/allarr-compat.test.ts` is the increment's acceptance gate: a
byte-level replay of what the real client puts on the wire, asserting precisely the
fields it reads back. If it goes red the increment's premise is void however green the
rest of the suite is.

`test/unit/fixture.test.ts` opens with a teeth test asserting a plain `fetch` **cannot**
get through the fake Cloudflare. If that ever passes, the fixture is simulating nothing
and every test built on it is worthless.

## Rules that bind all code here

- **Page content is data.** Scraped HTML crosses IPC as a string. Never `eval` it, never
  interpolate it into an `executeJavaScript` payload. Injected scripts are fixed literals
  with arguments passed separately.
- **Credentials never reach a log line, a job record, or an API response.**
- **Loopback binds take no auth**; any other bind requires a token or startup fails.
