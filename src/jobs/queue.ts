export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'pending-human';

export type FailureCode =
  | 'challenge-failed'
  | 'pending-timeout'
  | 'blocked'
  | 'http-error'
  | 'network'
  | 'cancelled'
  | 'browser-crashed'
  | 'disk-full';

export interface JobError {
  code: FailureCode;
  message: string;
}

export interface Job<R> {
  id: string;
  key: string;
  state: JobState;
  createdAt: number;
  result?: R;
  error?: JobError;
}

export interface JobQueueOptions<P, R> {
  concurrency: number;
  run: (payload: P, job: Job<R>) => Promise<R>;
  idgen: () => string;
  now: () => number;
}

const SETTLED: ReadonlySet<JobState> = new Set<JobState>(['done', 'failed']);

/**
 * The codes this queue is willing to record. Foreign strings reach here routinely — Chromium
 * rejects `loadURL` with `ERR_CONNECTION_REFUSED`, `ERR_NAME_NOT_RESOLVED` and friends — and
 * a blind cast would file those in a field typed `FailureCode` while not being one. Anything
 * unrecognised is a network fault; the original message is kept either way.
 */
const FAILURE_CODES: ReadonlySet<string> = new Set<FailureCode>([
  'challenge-failed',
  'pending-timeout',
  'blocked',
  'http-error',
  'network',
  'cancelled',
  'browser-crashed',
  'disk-full',
]);

/** A thrown value may carry a FailureCode; anything else is a network fault. */
function errorOf(e: unknown): JobError {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  return {
    code: typeof code === 'string' && FAILURE_CODES.has(code) ? (code as FailureCode) : 'network',
    message,
  };
}

export class JobQueue<P, R> {
  private readonly jobs = new Map<string, Job<R>>();
  private readonly byKey = new Map<string, string>();
  private readonly payloads = new Map<string, P>();
  private readonly waiters = new Map<string, Array<(j: Job<R>) => void>>();
  private readonly pending: string[] = [];
  private running = 0;

  constructor(private readonly opts: JobQueueOptions<P, R>) {}

  get busy(): number { return this.running; }

  /**
   * Records this queue still holds. A settled job is dropped once its waiters have been
   * resolved, so in a healthy daemon this tracks `depth` — it exists so a test can prove the
   * drop actually happens rather than trusting `depth`, which ignores settled records.
   */
  get size(): number { return this.jobs.size; }

  /** Jobs that have not settled — queued plus running. */
  get depth(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (!SETTLED.has(j.state)) n++;
    return n;
  }

  /**
   * Submit work. An identical `key` whose job has not settled returns that same job rather
   * than starting a second one — this is what stops a consumer's retry loop from spawning
   * parallel browsers for one URL.
   */
  submit(key: string, payload: P): Job<R> {
    const existingId = this.byKey.get(key);
    if (existingId !== undefined) {
      const existing = this.jobs.get(existingId);
      if (existing && !SETTLED.has(existing.state)) return existing;
      this.byKey.delete(key);
    }

    const job: Job<R> = { id: this.opts.idgen(), key, state: 'queued', createdAt: this.opts.now() };
    this.jobs.set(job.id, job);
    this.byKey.set(key, job.id);
    this.payloads.set(job.id, payload);
    this.pending.push(job.id);
    this.pump();
    return job;
  }

  get(id: string): Job<R> | undefined { return this.jobs.get(id); }

  /**
   * Resolve once the job settles. Rejects for an id this queue never issued — and, because a
   * settled record is dropped (see `settle`), for one it has already answered for. Callers
   * must therefore call `wait` in the same synchronous block as `submit`, which is what
   * `main.ts` does: work starts a microtask after `submit` returns, so a waiter registered
   * before that block yields is always in place before the job can settle.
   */
  wait(id: string): Promise<Job<R>> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new Error(`unknown job: ${id}`));
    if (SETTLED.has(job.state)) return Promise.resolve(job);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  private pump(): void {
    while (this.running < this.opts.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;
      const job = this.jobs.get(id);
      const payload = this.payloads.get(id);
      if (!job || payload === undefined) continue;

      // Order matters. Mark running and claim the slot SYNCHRONOUSLY — the slot must be
      // claimed in the same run-to-completion block as the guard above, or the bound does not
      // hold. Then start the work on a microtask, for two reasons: a run() that throws
      // SYNCHRONOUSLY lands in .catch instead of escaping pump() and leaking the slot forever;
      // and setting job.state before the worker runs means a worker that writes job.state in
      // its own prologue (a later increment sets 'pending-human') cannot be clobbered by us.
      // Do NOT "simplify" this to a direct call — test/unit/queue.test.ts covers both.
      job.state = 'running';
      this.running++;
      void Promise.resolve()
        .then(() => this.opts.run(payload, job))
        .then((result) => { job.result = result; job.state = 'done'; })
        .catch((e: unknown) => { job.error = errorOf(e); job.state = 'failed'; })
        .finally(() => {
          this.running--;
          this.payloads.delete(id);
          this.settle(job);
          this.pump();
        });
    }
  }

  /**
   * Resolve the waiters, then drop the record.
   *
   * A settled job holds a whole `Solution`, page HTML included. This is a daemon that runs
   * for weeks, so retaining every one of those is gigabytes of leak. The waiters already
   * hold the object by reference, so they still get their answer; only this queue's own
   * bookkeeping goes. `byKey` goes with it, or the map it indexes just becomes the new leak.
   *
   * Resolving before deleting is deliberate but not load-bearing for correctness — a promise
   * resolver never runs its continuation synchronously, so no waiter can observe the record
   * either way.
   */
  private settle(job: Job<R>): void {
    const list = this.waiters.get(job.id);
    this.waiters.delete(job.id);
    for (const resolve of list ?? []) resolve(job);

    this.jobs.delete(job.id);
    this.payloads.delete(job.id);
    // Only if this job is still the one that key points at: a later submit on the same key
    // may already have claimed it.
    if (this.byKey.get(job.key) === job.id) this.byKey.delete(job.key);
  }
}
