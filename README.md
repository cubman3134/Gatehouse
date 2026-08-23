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

Increment 1 **has** been run against a live Cloudflare-protected site, and so has the
download path — see the live-verification sections further down for the measurements.
What follows describes what the *test suite* proves on its own, which is a narrower
thing and worth keeping separate.

Every test here runs against a fake Cloudflare in `test/fixture/` — a local HTTP server
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
| `GATEHOUSE_DOWNLOADS_DIR` | *(Electron's `userData/downloads`)* | Directory the downloaded files live in. **Must be absolute** — a relative value is refused at startup, not resolved. Empty means "derive it", which is why the default is not a fixed path. |
| `GATEHOUSE_DOWNLOAD_CONCURRENCY` | `2` | Simultaneous downloads, 1–16. Separate from `GATEHOUSE_CONCURRENCY`, which caps *solving* windows. Each in-flight download does hold a hidden window of its own — see the live-verification section for why — so this is a memory knob as well as a bandwidth one. |
| `GATEHOUSE_DOWNLOAD_TTL_MS` | `86400000` (24h) | How long a **completed** download's bytes survive without a `DELETE`, 60000–2592000000. |
| `GATEHOUSE_DOWNLOAD_MAX_BYTES` | `53687091200` (50 GiB) | Cap on the downloads directory, 1048576–9007199254740991. Least-recently-served completed files evict first. |
| `GATEHOUSE_DOWNLOAD_STALL_MS` | `120000` (2m) | How long one download may go with **no progress at all** before it is aborted, 5000–3600000. An idle window, not a time limit on the download. |
| `GATEHOUSE_DOWNLOAD_NO_START_MS` | `60000` (1m) | How long to wait for a download to **begin at all** before giving up, 5000–600000. A different fault from a stall: nothing was ever received, so there is no item and no bytes to name. |

A bad value is a startup failure with the range in the message, not a silent fallback. That
includes a relative `GATEHOUSE_DOWNLOADS_DIR`: it would be resolved against whatever directory
`electron .` happened to be launched from, which is a different place after a restart from
another shell, and the `path` handed back on a completed download — documented below as a path
you give to another process — would be a meaningless relative string. Two readings of a
relative value are plausible and we are not told which you meant, so it is refused rather than
guessed at.

**`GATEHOUSE_DOWNLOAD_STALL_MS` is an idle timer, not a deadline.** A multi-GB download is
allowed to take hours; what it may not do is sit for two minutes with the received-byte count
not moving. This exists because a host that goes quiet mid-body produces no error and no
completion — measured, an interrupted item sat that way past 300s — so it would hold one of
`GATEHOUSE_DOWNLOAD_CONCURRENCY` slots until the process restarted, and two such hosts would
wedge the whole download surface while `/gh/fetch` kept answering 202 to work that never ran.
Progress is persisted every 4 MB, so the window has to stay comfortably above the time to move
4 MB on the slowest link you care about; the floor of 5000 is there to stop it being tightened
into killing healthy-but-slow downloads. An abandoned download settles `failed` with code
`network` — a host fault, not a cancel. See `DELETE /gh/jobs/:id` below.

**`GATEHOUSE_DOWNLOAD_NO_START_MS` bounds the other half of that.** The stall window watches an
item that exists and has stopped moving; this one watches the request phase, where a host that
accepts the socket and then writes nothing never produces an item at all — no bytes, no error,
nothing to cancel. Both are needed and they report different messages, so a log line says which
happened. It can be much tighter than the stall window because it is not competing with the
4 MB progress throttle: nothing has been received yet.

**Which of the two names a request-phase hang depends on their ordering, and nothing enforces
one.** The stall watchdog starts its clock when the job does rather than waiting for an item, so
a host that never sends a status line is inside *both* windows and whichever is shorter reports
it. At the defaults that is `GATEHOUSE_DOWNLOAD_NO_START_MS`, which is the more precise answer
— "the download never started". Set `GATEHOUSE_DOWNLOAD_STALL_MS` below it and the same host is
reported as a download that stopped advancing instead: true, since it never advanced, but less
specific. No relationship is imposed because the inversion is useful — it is how the test suite
reaches the watchdog without sitting through a 60s request phase.

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
wired in — `downloads: { active, records }`: downloads running right now, and how many
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
second download. Once a job has settled it is no longer open, so a repeat request generally
starts a fresh download — a completed one must not pin a caller to bytes that may already have
been released.

**A settled job is never reclaimed.** Re-`POST`ing a target whose previous attempt `failed`
starts a genuinely new download under a new `jobId`, from zero. There is no "resume the failed
one" path, and that is deliberate rather than missing: under the browser stack every reachable
failure settles with **no partial on disk** — ending a stalled download means cancelling the
item, and Chromium deletes the file of an item it cancelled — so there is nothing a reclaim
could continue from. Retry resilience *within* one download comes from Chromium's own retry of
a dropped ranged transfer; across a process restart it comes from the re-queue described under
"Interrupted downloads resume on the next start", which is a different mechanism and still
applies.

### `GET /gh/jobs/:id`

```json
{ "state": "running", "progress": { "received": 4194304, "total": 734003200 } }
```

`state` is `queued` | `running` | `done` | `failed` | `cancelled`. `total` is `-1` when the
server declared no length — a chunked response, and **any brotli-encoded one**, which is
common. It is never `0`: Chromium reports an unknown total as `0` and that would read as an
empty file, so it is translated. `total` only becomes the real figure when the download
completes. On `done` a `result` appears:

```json
{ "result": { "path": "C:\\Users\\you\\AppData\\Roaming\\gatehouse\\downloads\\<id>.bin",
              "url": "/gh/files/<id>",
              "size": 734003200, "sha256": "…", "filename": "big.iso",
              "contentType": "application/octet-stream" } }
```

`path` is for a consumer on the same machine that would rather move the file than stream it;
`url` is for one that would rather stream. `filename` is the name the **remote server**
suggested and is metadata only — files on disk are always `<id>.bin`, never a remote name.
On a failure, `error` carries `{code, message}` with `code` one of `network`, `disk-full` or
`cancelled`. **There is no HTTP status in there**, on any failure: the browser does not expose
one on a download item, so a 404 arrives indistinguishably as an interrupt with zero bytes and
no file. `message` is the only detail available, and it is for a human.

### `DELETE /gh/jobs/:id`

`204`, always, for a job that exists. For a settled job it drops the record and both files
— this is how a consumer says "I have the bytes, you can have the disk back". For one still
running it requests a **cancel**, which is asynchronous: the engine notices, cancels the
browser's download item, and only marks the record `cancelled` once Chromium has released the
file. Poll until the state settles if you need to know it landed.

That asynchrony has a wrinkle worth knowing: the `204` says the cancel was *requested*, not
that it landed. A job still `queued` — nothing running yet, so nothing to interrupt — answers
`204` and then stays unsettled until the queue reaches it and the engine settles it
`cancelled`, which is a slot away rather than instant. During that window `GET /gh/jobs/:id`
still reports `queued` or `running`, and the record is still open, so a `POST /gh/fetch` for
the same target dedupes onto the job you just cancelled. If you mean to start over, wait for
the state to settle first.

`cancelled` means **you** cancelled it. An idle download abandoned by
`GATEHOUSE_DOWNLOAD_STALL_MS`, or one that never began within
`GATEHOUSE_DOWNLOAD_NO_START_MS`, does not settle that way: a host that stops sending is a
retryable fault you did not ask for, so it settles `failed` with code `network` and a message
naming which of the two happened. Reporting the far end going quiet as your own doing would be
a lie about who acted.

What it does *not* do is keep the bytes. Ending a stalled browser download means cancelling the
item, and Chromium deletes the partial of an item it cancelled, so a stalled record settles
with nothing on disk and a retry is a fresh download.

The watchdog still only *aborts*; it passes a reason with the abort and the download engine
settles the record itself, once Chromium has released the file, so exactly one place writes a
terminal state.

### `GET /gh/files/:id`

The bytes, with `Accept-Ranges: bytes` and full `Range` support (`206`, `Content-Range`, `416`
for an unsatisfiable range). `HEAD` works. `409` while the job is not `done`; `404` for an
unknown id, and also for a `done` job whose bytes are no longer on disk.

**One response on this route does not use the `/gh/*` error envelope.** If the file cannot be
opened once the response has already been committed — it was removed or locked between the
`stat` and the read — the answer is a `500` whose body is:

```json
{ "error": "file unavailable" }
```

`error` is a **string** there, not the `{code, message}` object documented below. It is a known
inconsistency, not a second contract to code against: by that point the status line is on the
wire and the body is a best-effort explanation. Parse `error` defensively on this route — check
whether it is an object before reaching for `error.code`.

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

### Interrupted downloads resume on the next start

Kill the app mid-download and the bytes already on disk are not thrown away. On the way up,
before anything is served, Gatehouse re-queues every download the previous process was still
running **that still has its partial file**, under its *original* job id. A consumer that was
polling `/gh/jobs/<id>` before the restart keeps polling the same URL and sees the job pick up,
instead of a `failed` it has no way to retry against.

Whether it truly *resumes* or quietly starts over is decided per download, and the rule is
strict: **a partial is only continued when the original response carried an `eTag` or a
`Last-Modified`.** That header is the `If-Range` validator, and it is the only thing that makes
the server itself refuse a mismatched continuation — Chromium validates a resume's *length* and
never its content, so a partial holding the wrong bytes would resume to `completed` and corrupt.
With no validator the partial is discarded and the file is pulled again from zero. Measured,
that is also the honest description of what would happen anyway: with neither header
`createInterruptedDownload` silently restarts at byte 0 while still reporting that it can
resume. Worth knowing before you size a disk around it — **the one real host this was verified
against sends neither header, so for that host a resume is a re-download.**

Only genuinely interrupted downloads come back. One that failed for a real reason — a `404`, a
`206` from an offset we did not ask for, a full disk — stays `failed`, because retrying it on
every start would just hit the same wall every time. One whose partial is gone stays `failed`
too: there is nothing to resume from, and re-fetching it from zero is the caller's call to make,
not ours. Re-queued records are unsettled again *before* the retention sweep runs, so a partial
that outlived `GATEHOUSE_DOWNLOAD_TTL_MS` while the daemon was down is resumed rather than
reclaimed out from under the download.

A restart is the **only** thing that resumes. A re-`POST` after a failure does not: it starts a
new download under a new id, for the reason given under `POST /gh/fetch` — a failure under the
browser stack leaves no partial to continue from in the first place.

The rest of what used to be described here — refusing a `200` that ignored our `Range`, refusing
a `206` from an offset we did not ask for or one with no readable `Content-Range` — was the work
of a byte-stream transfer that placed the response into the file itself. Chromium owns that now,
and the safety that matters is upstream of it: without a validator we do not ask for a
continuation at all. Resuming is an optimisation; correctness is not negotiated for it.

### Retention will delete your file

There is a safety net for a consumer that never calls `DELETE`, and it is a real one, not a
formality. A **completed** download is removed once it is older than `GATEHOUSE_DOWNLOAD_TTL_MS`
(24h by default), and completed downloads are evicted least-recently-served-first whenever the
directory exceeds `GATEHOUSE_DOWNLOAD_MAX_BYTES`. The sweep runs on startup, after every
download, and hourly — the last one so that a daemon nobody downloads anything through still
honours the TTL rather than holding expired bytes until the next request.

So: **a completed download that was never released can be deleted out from under you.** If
you took the local `path` and have not copied or moved the file yet, it can vanish. Copy it,
or `DELETE` it when you are done, or raise the TTL. An unsettled record is never swept, at
any age or size.

### Live verification, 2026-08-23: `/gh/fetch` works end to end

Re-run against the same real Cloudflare-protected file that the previous engine could not
fetch, on a session solved moments earlier:

| step | result |
|---|---|
| `/v1` regression | `ok`, `cf_clearance` present, 4.8s |
| `POST /gh/fetch` | **`done`** — 10,759,939 bytes |
| content | real JSON, 8,679 entries — not an interstitial |
| `sha256` | independently hashed from the file on disk, matches the reported digest |
| `GET /gh/files/:id` | 200, byte-identical to disk |
| `Range: bytes=100-199` | 206, `content-range: bytes 100-199/10759939`, byte-equal slice |
| `DELETE /gh/jobs/:id` | 204, then 404, and the file gone from disk |

The measurement that forced this engine is kept below, because it is the reason it exists.

### Live verification, 2026-08-22: only the browser's own download stack gets the bytes

This was run against a real Cloudflare-protected file, and the `net.request` path **failed**.
The result is worth stating precisely, because it inverted an assumption in the design, and
because it is why the code looks the way it does now.

Immediately after a successful solve, with a valid `cf_clearance` in the partition:

| how the bytes were requested | result |
|---|---|
| `net.request({session})` | **403** — 5,851 bytes of interstitial |
| `net.request({session, useSessionCookies: true})` | **403** |
| `net.request({session, credentials: 'include'})` | **403** |
| `net.request` + the window's exact `User-Agent` | **403** |
| `webContents.downloadURL` → `will-download` | **completed, 10,759,939 bytes** of real content |

Two things came out of that.

**`useSessionCookies` defaults to `false`.** Passing a `session` to `net.request` buys the
partition's network stack but *not* its cookie jar, so the clearance was never being sent at
all. Fixed — but it turned out to be necessary rather than sufficient.

**The design had its two mechanisms the wrong way round.** It called `net.request` the normal
path and `will-download` "the escape hatch for a URL that only materialises from a page
action". Against a host that fingerprints, the escape hatch is the *only* path that works:
Cloudflare tells the `net` client from the renderer even with the same partition, the same
cookie and the same User-Agent.

What is **not** being done about that: hand-forging Chrome's header set onto `net.request`.
That is fingerprint-mimicry, which this project rules out, and it would break the next time
Cloudflare retunes. Driving the browser's own download stack is both the honest answer and the
durable one.

**So the browser-initiated path is what shipped, and the `net.request` one is deleted.** Not
kept as a fallback: a second download implementation that cannot fetch from the hosts this
project exists for is complexity with no reader, and a fallback that silently gets a 403 page
instead of a file is worse than no fallback. What replaced it:

- **Downloads go through Chromium's own download stack** — `webContents.downloadURL` on the
  partition that solved the challenge, adopted from that session's `will-download`. The
  clearance cookie, the TLS and HTTP/2 fingerprint, the header order: all of it is the browser's,
  because it *is* the browser.
- **One hidden window per in-flight download.** `will-download` fires on the session rather than
  the window, and for two concurrent downloads of the same target every field on the item — url,
  filename, mime type, total bytes, eTag — is identical while fire order does not match call
  order. The `webContents` the event carries is the only discriminator there is, so each job
  needs its own. `test/integration/browser-download.test.ts` runs two at once as the regression
  net for that; with a shared window it fails.
- **A download only resumes when the server gave an `eTag` or a `Last-Modified`**, and restarts
  from zero otherwise — see the section above. The real host measured here sends neither, **so
  for that host a resume is a re-download.**
- **`progress.total` is `-1` when the server sends no `Content-Length`**, which includes any
  brotli-encoded response. Never `0`.
- **A failure carries no HTTP status.** Chromium does not expose one on a download item, so a
  404 is reported as an interrupt with zero bytes rather than as a `404`.

None of that has been exercised against a multi-GB file or any real content source — see
directly below.

### What is not proven about downloading

The download path has **never been run against a real content source, and never against a
multi-GB file.** One real challenge-protected file was fetched by hand during the verification
above, and that is the whole of it. Every integration test here runs against a local fixture
HTTP server in `test/fixture/` that serves a few megabytes and can answer a range, answer
chunked with no length at all, or accept the socket and say nothing. That fixture proves the
*mechanism* — completion and hashing, two concurrent downloads not crossing, cancel both
mid-body and while still queued, the no-start bound, the idle watchdog freeing a wedged slot,
the unknown-total translation, dedupe and Range serving. It cannot prove behaviour at 4GB, on a
slow or flaky link, or against a host that is actually trying to tell a browser from a script.

The restart-resume path above is the **least** proven thing here, and it is worth saying so
plainly. The *decision* about what to re-queue is unit-tested against a hand-built manifest, and
the decision about whether a partial may be continued is unit-tested in `resumable.ts`. The
*wiring* — arming the one-shot, the save-path tripwire, the arguments handed to
`createInterruptedDownload`, and what happens when the call produces no item — is unit-tested in
`test/unit/browser.test.ts` against a **fake** session, because that call's `will-download`
emission is synchronous inside the call and nothing over HTTP can arrange for it. What has no
automated end-to-end coverage is a real kill-the-app-mid-body-and-restart against a host that
sends a validator — and since the one real host measured sends neither `eTag` nor
`Last-Modified`, the branch that actually continues a partial has never run against real
Chromium at all.

Three smaller things nothing here proves:

- **A genuine mid-body stall.** The idle watchdog is tested against a host that never sends a
  status line, which reaches it through the ordering described under the settings above. An item
  that exists, moves, and *then* stops — the case the failure message describes — is not
  exercised.
- **`ENOSPC` → `disk-full`.** The mapping is unit-tested by making the window factory throw with
  that errno. No test fills a disk.
- **The `updated` progress throttle at scale.** It is observed advancing across a 12MB chunked
  body; the 4MB spacing itself is not asserted.

Two specifics worth knowing before you rely on it. Hashing is a **second pass** over the
finished file rather than a streaming digest, so a large download is read from disk twice
— deliberate, and now unavoidable: the bytes are written by Chromium, not by us, so there is no
stream to digest on the way past, and a hash could not survive a resume or a restart anyway. And
while `will-download` is now how every download is adopted, a **page-action** download — one
whose URL only materialises when something is clicked — is still not built; a caller must supply
a final URL.

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
