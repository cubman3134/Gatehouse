# Gatehouse — design

**Date:** 2026-08-22
**Status:** approved, pending implementation plan

## Problem

Several of Allarr's content sources sit behind Cloudflare. Allarr's current answer is
`Allarr.Plugin/Transport/CloudflareCurlHandler.cs`: shell out to `curl` (whose TLS fingerprint
passes where .NET's `HttpClient` gets a flat 403), and when a host also runs a JS challenge,
mint a `cf_clearance` cookie via a FlareSolverr at `Plugins.allarr.GameSource.FlareSolverrUrl`
(default `http://localhost:8191`) and have curl carry it.

That works, but it depends on a third-party binary we do not control, it cannot handle a
challenge that needs a human, it cannot hold a logged-in session, and the curl replay is a
different TLS client from the one that earned the cookie — so it breaks on any host that binds
clearance to the fingerprint.

Gatehouse replaces FlareSolverr with something we own: an Electron app that drives a real
Chromium, clears challenges, holds persistent per-site sessions, downloads files through those
sessions, and answers a local HTTP API.

## Scope

Gatehouse is a **solver-proxy**. It fetches URLs and returns content or files. It holds no
site-specific knowledge — every parser, every URL-derivation flow stays in Allarr where it
already lives and already works.

**Non-goal, explicitly:** Gatehouse does not defeat CAPTCHAs. There is no solving service, no
token purchase, no bot-detection evasion beyond being an ordinary browser. Cloudflare's
non-interactive JS challenge clears simply by being a real Chromium, which covers the majority
of live cases. The interactive kind is solved by a person clicking it, once, in a window
Gatehouse surfaces.

Gatehouse automates a browser against sites the operator already has access to. Whether a given
site's terms permit automated access is a per-site decision made when that site is added, not
something this tool settles.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Role | Solver-proxy. Allarr keeps its parsers. |
| 2 | Deployment | Optional companion. Allarr works without it, uses it when reachable. |
| 3 | Fetch model | Gatehouse performs the fetch; Allarr does not replay cookies itself. See note. |
| 4 | File delivery | Download to disk; return **both** a local path and a Range-capable HTTP URL. |
| 5 | Human in the loop | Yes, for interactive challenges only. Logins are automated. |
| 6 | Browser | Electron, not Playwright. |

### On decision 3

Decision 3 describes the **end state**, not increment 1. Increment 1 is drop-in
FlareSolverr compatibility with zero Allarr changes, which means Allarr keeps replaying the
minted cookie through curl for as long as it wants to. Gatehouse serves the solved body from
day one; Allarr switches to consuming it in increment 5. Both arrangements work — the second
is simply better, and decoupling them is what lets increment 1 ship without touching Allarr.

### On decision 6

Playwright drives Chromium over CDP and leaves `navigator.webdriver === true` by default — the
reason `playwright-stealth` exists. An Electron `BrowserWindow` is a plain Chromium app process:
no CDP, no automation flags, `navigator.webdriver` false. Against the fingerprinting this tool
must not trip, Electron is the less-detectable option with no patching. Playwright's better API
does not outweigh that. Playwright may be used in the test suite; it does not touch the live
path.

This is a moving target, not a guarantee.

## Architecture

One Electron process, four parts.

```
                 +---------------- Gatehouse (Electron) ----------------+
Allarr --HTTP--> |  API server (127.0.0.1:8191)                         |
                 |    +-- /v1          FlareSolverr-compatible          |
                 |    +-- /gh/fetch    download a file                  |
                 |    +-- /gh/jobs/:id poll (incl. 202 pending)         |
                 |    +-- /gh/files/*  Range-capable static server      |
                 |                                                      |
                 |  Job queue  --> Browser pool (N hidden BrowserWindows)|
                 |       |             +-- one persist: partition/site  |
                 |       +--> Store: jobs, downloads dir, safeStorage   |
                 +------------------------------------------------------+
```

**API server** — plain Node HTTP in the Electron main process. Binds `127.0.0.1` by default.
Binding elsewhere requires an explicit setting *and* a bearer token; the server refuses to start
bound non-loopback without one.

Port 8191 is FlareSolverr's, chosen so an existing `FlareSolverrUrl` needs no edit. If a real
FlareSolverr already holds the port, Gatehouse must fail startup with that diagnosis rather than
a bare `EADDRINUSE` — the two are interchangeable on the wire, so a silent fallback to a
different port would leave the operator unsure which one Allarr is talking to. The port is
configurable for the case where both should run side by side.

**Job queue** — every request is a job with state
`queued | running | done | failed | pending-human`. Bounded concurrency (default 2 windows; each
is a real Chromium). The queue is what makes `202 pending` expressible.

**Browser pool** — hidden `BrowserWindow`s, one persistent session partition per site
(`persist:vimm`, `persist:romhack`). `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`.

**Store** — job records (persisted, so a restart resumes), a downloads directory, and
credentials in `safeStorage`.

### Untrusted renderer

The renderer runs whatever the site serves. Scraped HTML crosses IPC as a **string** — never a
live object, never `eval`'d, never interpolated into an `executeJavaScript` payload. Page content
is data, never instructions. Any in-page script Gatehouse injects is a fixed literal with
arguments passed separately.

## API

### `/v1` — compatibility surface

Not ours to design. Matches FlareSolverr exactly so Allarr needs **zero code changes**.

```
POST /v1  {"cmd":"request.get","url":"...","maxTimeout":60000,"session":"vimm"}
-> {"status":"ok","solution":{"url","status","headers","cookies":[...],"userAgent","response":"<html>..."}}
```

Supported: `request.get`, `request.post`, `sessions.create`, `sessions.list`,
`sessions.destroy`. Unknown commands return FlareSolverr's error shape, not a 404, so a stray
call degrades the way Allarr already expects.

`solution.response` carries the solved HTML, so decision 3 is already satisfied for pages by this
endpoint. Allarr currently discards that body and replays the cookie through curl; it need not,
and fetches better if it does not. That is increment 5, not increment 1.

### `/gh/*` — our surface

```
POST   /gh/fetch      {url, site?, referer?, filename?}  -> 202 {jobId}
GET    /gh/jobs/:id   -> {state, progress:{received,total}, result?, error?}
DELETE /gh/jobs/:id   -> cancel (kill transfer, delete partial)
GET    /gh/files/:id  -> bytes, Range-capable
GET    /gh/health     -> {version, browsers:{busy,total}, queue:{depth}}
```

`site` is a caller-chosen session name, not a hostname — it selects the persistent partition
(`persist:<site>`) the request runs on, and is the same string `/v1`'s `session` field takes. Two
callers using the same `site` share cookies and login state by design. Omitted, the request runs
on a partition derived from the URL's registrable domain.

`/gh/files/:id` takes the **jobId** of a completed download; there is no separate file id. A file
is reachable only while its job record exists.

On success, `result` is `{path, url, size, sha256, filename, contentType}` — both the local path
and the HTTP URL, so a same-machine consumer takes the path (zero extra copies) and a remote one
takes the URL.

On `pending-human`, the job carries `{reason:"interactive-challenge", host}` and the window has
surfaced. The job parks until solved or until a wall-clock deadline (default 5 min), then fails
`pending-timeout`.

### Three API rules

**Auth is loopback-conditional, and must be.** Allarr's existing FlareSolverr client sends no auth
header; requiring a token would break drop-in compatibility immediately. Bound to `127.0.0.1`: no
auth. Bound to anything else: bearer token mandatory, enforced at startup. An open browser-driver
cannot be exposed to a LAN by accident.

**Downloads are jobs, not responses.** No synchronous multi-GB HTTP response. A large file gets
`202` at once, streams to disk, and is polled. Cancel cancels; a dropped consumer connection does
not lose the transfer.

**Same URL in flight twice is the same job.** Dedupe on `(url, site)`. Stops an Allarr retry loop
from spawning parallel Chromiums pulling the same file.

### Deferred (YAGNI)

Returning the page's network-request log so a consumer can locate hidden media URLs. Useful, not
needed for anything to work, and addable behind one response field later. Recorded as a decision
rather than an omission.

## Challenge handling

Load in a hidden window on the site's partition, then wait for an outcome rather than a fixed
sleep:

1. **Cleared** — no `cf-mitigated` header, status not 403/503, no challenge markup, document
   settled. Return the HTML.
2. **Still challenged after `maxTimeout`** — only now is it possibly the interactive kind.
   Surface the window; job becomes `pending-human`.
3. **Hard block** — 1020/1015, or repeated challenge failure. Fail fast with a distinct code. Do
   **not** retry in a loop; hammering a soft block is how it becomes permanent.

> **Corrected 2026-08-22 by live verification — do not undo this.** An earlier version treated a
> Turnstile widget in the DOM as an *immediate* "interactive" verdict. That is wrong, and it
> broke the product against the first real site it met. Measured against a live challenged host,
> Cloudflare's **managed** challenge renders a Turnstile **invisibly and solves it itself**:
>
> ```
> t=0     403 cf-mitigated=challenge   markers=[challenges.cloudflare.com/turnstile,
>                                               challenge-platform, cf_chl_opt]
> t=1000  403                          markers=[cf-turnstile, ...]   <- widget appears
> t=2000  200 + cf_clearance + the real 11.4MB body                   <- self-solved, no human
> ```
>
> So the presence of a widget carries **no** signal about whether a person is needed, and
> `challenges.cloudflare.com/turnstile` least of all — it is the script host injected on the
> normal invisible path, present from the first byte. Turnstile markers therefore mean **keep
> polling**. "Needs a human" is a judgement made *only* when the deadline expires with a widget
> still present.
>
> The local fixture could not have caught this: it modelled interactive as
> widget-present, which is simply not how the real thing behaves.

Once a partition has cleared a host, later requests on that partition normally skip all of this.
That is the reason partitions are persistent.

## Logins

Per-site recipe: `{loggedOutSignal, url, steps:[{selector, valueRef|literal}], submit,
successSignal}`. Runs only when `loggedOutSignal` matches, so it is off the hot path. `valueRef`
names a `safeStorage` key; never a literal credential.

Rules the implementation must obey:

- Credential values live only in `safeStorage` (DPAPI on Windows, Keychain on macOS), decrypted
  at point of use.
- Never in a job record, never in a log line, never in any API response — `/gh/health` and error
  bodies included.
- Typed via `insertText` into a focused field, never interpolated into an `executeJavaScript`
  string. String-building a script from a credential is how it reaches a stack trace.

Credentials are configured by the operator through the app's own window. Gatehouse never creates
an account and never signs up for anything; it signs in to accounts that already exist.

## Downloading

Two mechanisms:

- **Direct URL** — `net.request` on the site's partition. Carries that partition's cookies and
  Chrome's real TLS fingerprint. The normal path.
- **Browser-initiated** — navigate and catch `session.will-download`. The escape hatch for a URL
  that only materialises from a page action.

Streams to `downloads/<jobId>.part`, hashes while streaming, renames on completion. Restart-safe:
a partial resumes via `Range` where the server allows it, restarts where it does not.

**Boundary:** Gatehouse fetches URLs; it does not know site flows. A source whose download is a
session-coupled two-hop stays Allarr's knowledge — Allarr derives the final URL and passes it
with a `site` and a `referer`. A site that genuinely cannot be reduced to a URL and requires a
click is the deferred recipe feature, to be designed when a real site forces it.

## Failure taxonomy

Every failure carries a stable code so a consumer can distinguish degrade from retry:

`challenge-failed`, `pending-timeout`, `blocked`, `http-error`, `network`, `cancelled`,
`browser-crashed`, `disk-full`.

A renderer crash takes one window; the pool respawns it and the job fails `browser-crashed`
rather than wedging the queue.

Gatehouse being down is indistinguishable from FlareSolverr being down, and Allarr already covers
that: its tests assert a FlareSolverr that throws is swallowed rather than faulting the request.
The degradation path exists before we start.

## Testing

A Cloudflare solver cannot be tested against Cloudflare — non-deterministic, rate-limited, and CI
would become a site-abuse machine.

**Build a fake Cloudflare.** A local fixture server that 503s with an interstitial on first hit,
sets `cf_clearance` only after its JS actually executes, 403s any request without the cookie, and
has a mode demanding a click. The whole solve path then tests offline and deterministically.

**The fixture is checked for teeth.** Its first test asserts a *plain* `fetch` against it gets
403. If the naive client passes, the fixture simulates nothing and every test above it is
theatre. Likewise the interactive mode asserts the automated path *fails* it, or `pending-human`
is never exercised.

Layers:

- **Unit** — queue state machine, dedupe, error taxonomy, Range/partial-content edges, resume
  arithmetic. No Electron.
- **Redaction, as a property** — sweep every log line, job record and API response for any
  configured credential value. Asserts a negative, so it carries a mutant: plant a credential in
  a log line and confirm the test goes red.
- **Integration** — real Electron, fake Cloudflare, real file; resume, cancel, restart,
  crash-respawn.
- **Live smoke** — manual, one script, explicitly outside CI, run when adding a site.

## Increments

Each ships independently and leaves the system working.

| # | Scope | Done when |
|---|---|---|
| 1 | Electron shell, hidden window pool, job queue, `/v1`, fake-Cloudflare rig | `FlareSolverrUrl` points at Gatehouse and the PC-game feed works. Zero Allarr changes. |
| 2 | `/gh/fetch`, job polling, Range file server, resume/cancel/dedupe | A large file downloads through a solved session, survives restart, cancels cleanly |
| 3 | Window surfacing, `pending-human`, `202` + deadline, minimal panel (request log, "open browser here") | An interactive challenge parks, is clicked, the job completes |
| 4 | Login recipes, `safeStorage`, redaction gate | A signed-in site stays signed in across restarts |
| 5 | *Allarr side, optional* — consume `solution.response` directly; route ROM downloads through `/gh/fetch` | The curl shell-out is off the hot path |

Increment 1 proves the premise and is small. Stop and evaluate before committing to the rest.

## Repository

Gatehouse is a **private** repo alongside `Allarr` and `EverythingBoxServer`. This spec names
Allarr and specific content sources, so it must not land in the public EverythingBox repo, whose
`RepositoryCleanlinessTests` scans git history — a slip there needs a history rewrite, not a
follow-up commit.
