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
| `GATEHOUSE_DOWNLOADS_DIR` | *(Electron's `userData/downloads`)* | Absolute directory the downloaded files live in. Empty means "derive it", which is why the default is not a fixed path. |
| `GATEHOUSE_DOWNLOAD_CONCURRENCY` | `2` | Simultaneous transfers, 1–16. Separate from `GATEHOUSE_CONCURRENCY`: a download holds no browser window. |
| `GATEHOUSE_DOWNLOAD_TTL_MS` | `86400000` (24h) | How long a **completed** download's bytes survive without a `DELETE`, 60000–2592000000. |
| `GATEHOUSE_DOWNLOAD_MAX_BYTES` | `53687091200` (50 GiB) | Cap on the downloads directory, 1048576–9007199254740991. Least-recently-served completed files evict first. |

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

Version, browser-pool `busy`/`total`, solve-queue depth, and — once the download surface is
wired in — `downloads: { active, records }`: transfers running right now, and how many
download records the store is holding. `HEAD` works too.

## Downloading

`/gh/*` is Gatehouse's own surface, not FlareSolverr's. A client asks for a URL, Gatehouse
pulls it **through the browser session that solved the challenge**, writes it to disk, and
hands back both a local path and an HTTP URL. That is the point of routing a download through
a browser at all: the bytes come down the same Chromium partition that holds the
`cf_clearance` cookie, carrying Chromium's TLS and HTTP/2 fingerprint rather than Node's. A
host that hands a cleared browser a file and hands a bare HTTP client a challenge page cannot
tell the two apart here, because it *is* the same network stack.

The whole surface is mounted only when a download store is wired in. Nothing else changes:
`/v1`'s request shape, response shape, statuses and auth model are untouched.

### `POST /gh/fetch`

```json
{ "url": "https://host.example/big.iso", "site": "host.example", "referer": "https://host.example/page" }
```

`url` is required and must be `http:` or `https:` — the same gate `/v1` applies, from the same
module. `site` is the partition name (`/^[A-Za-z0-9._-]{1,64}$/`, not all dots); omit it and
one is derived from the hostname. `referer` is optional and must itself be a plain http(s)
URL: it is the one caller-supplied value sent onward to a third party, and it is persisted
into a manifest that is rewritten on every progress tick.

Answers `202` with `{"jobId":"…","state":"queued"}`. A second `POST` for the same
`site` + `url` while the first is still unsettled returns **that** job rather than starting a
second transfer. Once a job has settled it is no longer open, so a repeat request starts a
fresh download — a completed one must not pin a caller to bytes that may already have been
released.

### `GET /gh/jobs/:id`

```json
{ "state": "running", "progress": { "received": 4194304, "total": 734003200 } }
```

`state` is `queued` | `running` | `done` | `failed` | `cancelled`. `total` is `-1` when the
server declared no length (a chunked response). On `done` a `result` appears:

```json
{ "result": { "path": "C:\\Users\\you\\AppData\\Roaming\\gatehouse\\downloads\\<id>.bin",
              "url": "/gh/files/<id>",
              "size": 734003200, "sha256": "…", "filename": "big.iso",
              "contentType": "application/octet-stream" } }
```

`path` is for a consumer on the same machine that would rather move the file than stream it;
`url` is for one that would rather stream. `filename` is the name the **remote server**
suggested and is metadata only — files on disk are always `<id>.bin`, never a remote name.
On a failure, `error` carries `{code, message}` with `code` one of `http-error`, `network`,
`disk-full`, `cancelled`.

### `DELETE /gh/jobs/:id`

`204`, always, for a job that exists. For a settled job it drops the record and both files
— this is how a consumer says "I have the bytes, you can have the disk back". For one still
running it requests a **cancel**, which is asynchronous: the transfer notices, closes its
stream, deletes its partial and only then marks the record `cancelled`. Poll until the state
settles if you need to know it landed.

### `GET /gh/files/:id`

The bytes, with `Accept-Ranges: bytes` and full `Range` support (`206`, `Content-Range`, `416`
for an unsatisfiable range). `HEAD` works. `409` while the job is not `done`; `404` for an
unknown id, and also for a `done` job whose bytes are no longer on disk.

### Errors here are not `/v1` errors

Everything under `/gh/*` answers a rejection with the real HTTP status and this body:

```json
{ "error": { "code": "bad-request", "message": "…" } }
```

`code` is `bad-request` (400/405), `not-found` (404), `not-ready` (409) or `internal` (500).

That is deliberately **not** what `/v1` does. `/v1` answers every rejection of a well-formed
POST with a `500` carrying FlareSolverr's `{"status":"error","message":…}`, because that is
the shape existing FlareSolverr clients already degrade on and it is not ours to redesign.
`/gh/*` has no such legacy: it is a new surface with new clients, so it uses ordinary status
codes and a machine-readable `code`. Two different contracts, on purpose — do not "unify" them.

### Retention will delete your file

There is a safety net for a consumer that never calls `DELETE`, and it is a real one, not a
formality. A **completed** download is removed once it is older than `GATEHOUSE_DOWNLOAD_TTL_MS`
(24h by default), and completed downloads are evicted least-recently-served-first whenever the
directory exceeds `GATEHOUSE_DOWNLOAD_MAX_BYTES`. The sweep runs on startup and after every
transfer.

So: **a completed download that was never released can be deleted out from under you.** If
you took the local `path` and have not copied or moved the file yet, it can vanish. Copy it,
or `DELETE` it when you are done, or raise the TTL. An unsettled record is never swept, at
any age or size.

### What is not proven about downloading

The download path has **never been run against a real content source, and never against a
multi-GB file.** Every test here runs against a local fixture HTTP server in `test/fixture/`
that serves a few megabytes and can be told to truncate, stall, lie about `Content-Range` or
answer chunked. That fixture proves the *mechanism* — resume, cancel, dedupe, hashing, Range
serving, and the refusal to append a body the server did not actually send from the offset we
asked for. It cannot prove behaviour at 4GB, on a slow or flaky link, or against a host that
is actually trying to tell a browser from a script.

Two specifics worth knowing before you rely on it. Hashing is a **second pass** over the
finished file rather than a streaming digest, so a large download is read from disk twice
— deliberate, because a streaming hash cannot survive a resume or a restart and a wrong
`sha256` is worse than a slow one. And the `session.will-download` escape hatch, for a URL
that only materialises from a page action, is **not built**; a caller must supply a final URL.

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
