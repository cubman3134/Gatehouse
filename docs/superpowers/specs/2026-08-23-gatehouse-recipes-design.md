# Gatehouse recipes — design

**Date:** 2026-08-23
**Status:** approved, pending implementation plan
**Supersedes:** the "deferred recipe feature" paragraph in the Downloading section of
[the increment-1 design](2026-08-22-gatehouse-design.md)

## Problem

The original design drew a boundary: *"Gatehouse fetches URLs; it does not know site flows. A
source whose download is a session-coupled two-hop stays Allarr's knowledge — Allarr derives the
final URL and passes it with a `site` and a `referer`. A site that genuinely cannot be reduced to
a URL and requires a click is the deferred recipe feature, to be designed when a real site forces
one."*

A real site has now forced one.

Measured against romhackplaza.org on 2026-08-23:

- Its download is behind a Livewire click: the item page → click **Download** →
  `POST /livewire-*/update` → a modal reveals `/api/fs/download/{entryId}/{uuid}`. The file URL
  does not exist in the page until the click happens.
- That URL is a plain `GET`, so the old split *should* have worked: derive it in Allarr, hand it
  to `/gh/fetch`. It does not.

| the same URL, same uuid, fetched from | result |
|---|---|
| Gatehouse's own `romhackplaza` session, via `/gh/fetch` | `network`, 0 bytes, interrupted |
| the session that opened the modal | **completed, 2,215 bytes** |

The uuid was stable across probes, so it is not single-use — it is **session-coupled**. For this
source the derive and the fetch must happen inside **one** Gatehouse session, which the old split
cannot express.

## Scope

A **recipe** is a short declarative script the caller supplies with a fetch. Gatehouse runs it in
one hidden window on the target session, obtains a download URL, and downloads it **from that
same window**.

Gatehouse gains a *mechanism*, not *knowledge*. It still knows nothing about any site.

**Not in scope,** so the vocabulary stays sized to evidence: shadow-DOM and iframe traversal,
conditionals or loops, form filling, and login flows. Logins are a later increment and want
`safeStorage`, not a recipe field. If a real site forces any of these, that is the moment to add
it — the same rule that produced the three verbs below.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Who owns site knowledge | **The caller supplies the recipe per request.** Allarr already holds every parser and URL-derivation flow for its sources; Gatehouse executes generically. Adding a source needs no Gatehouse release, and a romhackplaza change is an Allarr edit rather than a redeploy of the thing the rig depends on for `/v1`. |
| 2 | Expressiveness | **A declarative step list over a small fixed vocabulary.** No caller-supplied JavaScript. |
| 3 | API shape | **An optional `recipe` on the existing `POST /gh/fetch`.** |

### On decision 2

The rejected alternative is a caller-supplied JavaScript snippet evaluated in the page. It
handles anything, but it makes `executeJavaScript(callerString)` a first-class feature in a
codebase whose entire discipline has been never to do that, and it means Gatehouse can no longer
say what a recipe will do. A declarative vocabulary can be validated, bounded and logged.

The bet is that the sources stay tractable. It is a real bet. It was sized against the one site
that has actually been measured, which needed exactly three moves.

### On decision 3

The rejected alternative — a separate `POST /gh/derive` returning a URL for the caller to feed
back to `/gh/fetch` — is the tempting one, and it is the option romhackplaza specifically
falsifies: it assumes the derived URL survives between two calls, and the measurement above shows
it does not.

`url` and `recipe` are mutually exclusive. When a recipe is present, `url` is **absent** and the
recipe's `startUrl` is the page to begin from. `url` therefore never means two different things.

## API

`POST /gh/fetch` — unchanged without a `recipe`. Every existing path, response and test is
untouched.

```json
{ "site": "romhackplaza",
  "referer": null,
  "recipe": {
    "startUrl": "https://romhackplaza.org/romhacks/battletoads-extended-…",
    "steps": [
      { "op": "click",         "selector": "button", "text": "Download" },
      { "op": "waitFor",       "selector": "a[href*='/api/fs/download/']" },
      { "op": "readAttribute", "selector": "a[href*='/api/fs/download/']", "attribute": "href" }
    ] } }
```

The response is the existing `202 {jobId, state}`, and the job is polled, cancelled, served and
released exactly as any other. **The `/gh/*` wire contract does not otherwise change.**

**Request validation changes in exactly one way:** `/gh/fetch` currently requires `url`. It will
require **exactly one of `url` or `recipe`** — neither is a `400`, both is a `400`. That is the
only behavioural change to an existing endpoint in this increment.

**`referer` is ignored on the recipe path,** and rejected rather than silently dropped. The
download is issued from a window that navigated from `startUrl`, so the browser sets its own
`Referer`; honouring a caller's value would mean overriding the browser with a header we made up,
which is the sort of thing this project does not do. Sending both is a `400`.

### The vocabulary

Three verbs, plus one field a real site forced.

| op | fields | behaviour |
|---|---|---|
| `click` | `selector`, `text?` | Click the first match. |
| `waitFor` | `selector`, `text?` | Resolve once a match exists, or fail on the step's timeout. |
| `readAttribute` | `selector`, `attribute` | Read the attribute off the first match. |

CSS cannot select by text, and the control that matters on romhackplaza is a `<button>` reading
"Download" — hence `text`, which filters matches by trimmed `textContent`. That is the whole
reason it exists.

**Which value is the URL, stated precisely** — this is the part most open to two readings, so it
is pinned here:

- If the recipe runs to completion, its **last step must be a `readAttribute`**, and that step's
  value is the URL. A recipe whose last step is `click` or `waitFor` is **rejected at validation
  time**, not left to fail later with nothing to download.
- If a download starts *during* the recipe (rule 4), that item **is** the result: the remaining
  steps are skipped and no `readAttribute` is required. This is the one case where a recipe
  legitimately ends without producing a URL.

So exactly one of those two things ends a recipe, and validation rejects a recipe that can do
neither.

## Flow

All of it inside one hidden window on the target session:

```
open window (persist:<site>)
  -> attach the will-download handler          <- BEFORE the recipe; see rule 4
  -> navigate to recipe.startUrl
  -> run steps in order
  -> derived URL  --(validateTarget)-->  wc.downloadURL(url)
  -> the existing will-download correlation, keyed on webContents
```

The final hop is not an assumption. A probe ran exactly this sequence against romhackplaza —
open, click, read the `href`, then `wc.downloadURL(href)` **in the same window** — and it
completed at 2,215 bytes where a separate session got nothing.

## Safety

Four rules. Three of them are forced by defects this project has already shipped and fixed.

**1. A caller string never becomes code.** `executeJavaScript` takes only a string, so building
one from a selector would mean interpolation — the thing every module here has avoided. Instead
the window carries a **preload script in the isolated world**, and the main process sends
`{op, selector, text, attribute}` over IPC; the preload does the DOM work and returns a value.
The page cannot reach the bridge (`contextIsolation`, `sandbox`, no `nodeIntegration`), and there
is no string to inject into.

`JSON.stringify` into a template literal would *probably* be safe. "Probably safe if validated"
is how `data-sitekey`, `just a moment` and `challenge-platform` each got in.

**2. The recipe is validated before anything runs.** Unknown `op` rejected; `selector`, `text`
and `attribute` length-capped; `attribute` restricted to a safe name pattern; step count capped;
`startUrl` through the **same `validateTarget` gate** as any caller-supplied URL, so `file:` and
every other scheme is refused exactly as it is on `/gh/fetch` today.

**3. The derived URL is hostile input, not a result.** `readAttribute` pulls a value out of a
page we do not control and we then hand it to a browser. A careless or compromised page can put
`file:///C:/Users/…` in that `href`. **The derived URL therefore goes back through
`validateTarget` before the download starts** — same allow-list, same rejection. Page content
stays data until it has passed the same gate a caller's input would.

**4. A download that starts mid-recipe must be claimed.** Not optional. A click can trigger the
download directly, without ever exposing an `href` — and an unclaimed `will-download` opens a
**native modal Save As dialog that never resolves**, which on a daemon is fatal (measured). So
the handler is attached **before** the recipe runs, and the first item on our window is **adopted
as the result**, ending the recipe there. That is also why a recipe may legitimately end in a
`click`, and it costs no extra code, because the handler has to be there regardless.

**Bounds.** Each step has its own timeout and the whole recipe has one, both configurable:
`GATEHOUSE_RECIPE_STEP_MS` (default 15000) and `GATEHOUSE_RECIPE_TOTAL_MS` (default 60000), each
validated the way every other download setting already is. Both sit inside the existing no-start
and stall watchdogs, which continue to bound the download that follows. The step cap is a
constant, not a setting: **12 steps**, which is four times what the one measured site needed.

## Failure handling

A recipe breaks when a site changes its markup, and the only useful thing to tell an operator is
*which* selector went stale. So the message names the step index and op:

> `step 2 (waitFor a[href*='/api/fs/download/']) matched nothing within 15000ms`

A new `error.code` of **`recipe-failed`** covers a step that did not match, a recipe that ran out
of time, and a derived URL the gate refused. It is additive to the documented set. Reporting a
stale selector as `network` would be a lie, and the whole value of the message above is that it
is specific.

Everything after the derived URL uses the existing codes unchanged.

## Testing

**The fixture mirrors the measured flow.** The local file host gains a page that does what
romhackplaza does: a button that, on click, reveals a download link after a short delay.
Deterministic, offline, shaped by a real site rather than by imagination. A second variant where
the click triggers the download directly covers rule 4.

- **Unit** — validation (unknown op, oversize selector, too many steps, bad attribute name,
  non-http `startUrl`), and the derived-URL gate: **a page yielding `file:///…` must be refused.**
  That is the sharpest test in the increment.
- **Integration, through the real app** — recipe → derived URL → download with sha256 verified;
  the click-triggers-download variant; and a recipe whose selector never matches, which must fail
  `recipe-failed` **within its bound rather than hang**. That last one carries a teeth check,
  because "fails eventually" and "fails correctly" are different claims.
- **Live** — romhackplaza. The same standard as increments 1, 2 and 2b: it is not done until it
  downloads a real file, and a green suite is not evidence of that.

## Known risk

A recipe is a selector contract with a site that has no obligation to keep it. **This feature
will break, silently, at a time of the site's choosing, and it will present as "downloads stopped
working".** Naming the failing step is what makes that one log line instead of an afternoon.

Nothing here changes the project's boundary: no CAPTCHA solving, no bot-detection evasion, no
fingerprint spoofing. A recipe clicks the buttons a person would click, in a browser that is
genuinely a browser.
