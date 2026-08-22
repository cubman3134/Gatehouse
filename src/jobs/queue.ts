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

/** A thrown value may carry a FailureCode; anything else is a network fault. */
function errorOf(e: unknown): JobError {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  return { code: typeof code === 'string' ? (code as FailureCode) : 'network', message };
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

  /** Resolve once the job settles. Rejects for an id this queue never issued. */
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

  private settle(job: Job<R>): void {
    const list = this.waiters.get(job.id);
    this.waiters.delete(job.id);
    for (const resolve of list ?? []) resolve(job);
  }
}
