/**
 * The abort reason that means "this transfer stopped moving", as against "the caller asked for
 * it to stop". The idle watchdog aborts with THIS value; a download engine reads it back off
 * `signal.reason` and settles accordingly.
 *
 * The two outcomes are genuinely different and must not share a terminal state. A caller's
 * cancel is the caller's own doing and its bytes are unwanted, so the record reads `cancelled`.
 * A stall is a retryable HOST fault the caller never asked for, and reporting it as `cancelled`
 * is a lie about who acted — one that `findResumable` then acts on, because it refuses a
 * `cancelled` record outright.
 *
 * A symbol, exported, rather than a sentinel string: only code that imports this binding can
 * produce a value that compares equal to it, so a caller's own `abort('stalled')` is still an
 * ordinary cancel, and neither side can drift by rewording a literal.
 *
 * **This module exists so that there is exactly one mint of it.** Identity is the whole
 * mechanism, and `Symbol()` is not interned: two modules that each write
 * `Symbol('gatehouse:download-stalled')` produce values that print the same and compare
 * unequal. The watchdog side and the settle side must import the same binding, and a mismatch
 * fails *silently* — every stall falls through to the caller-cancel branch, the record reads
 * `cancelled`, and the partial is neither kept nor reclaimable. So it lives alone, with no
 * engine attached: whichever engine `main.ts` is wired to, both sides can only agree.
 */
export const STALLED: unique symbol = Symbol('gatehouse:download-stalled');
