import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isReclaimable, isSettled, type DownloadRecord } from './record.js';
import { log } from '../log.js';

export interface StoreOptions {
  dir: string;
  now: () => number;
  idgen: () => string;
  ttlMs: number;
  maxBytes: number;
}

export interface DownloadInit {
  url: string;
  session: string;
  referer: string | null;
}

const MANIFEST = 'manifest.json';

/**
 * The only shape an id may take. It is a filename component, so this is what stops one
 * walking out of the downloads directory. Ids we mint are UUIDs, which satisfy it; the check
 * exists for ids that arrive from the manifest on disk, which is an editable file.
 */
const ID = /^[A-Za-z0-9_-]+$/;

/**
 * The exact message `load` stamps on a record it demoted because the process that owned it
 * died. It is exported because it is the ONLY thing that distinguishes "interrupted, and worth
 * resuming" from "failed for a real reason a retry will just hit again" — a 404, a refused
 * 206. `main.ts` matches on it to decide what to re-queue on the way up, and a literal copied
 * into that decision would drift away from this one silently.
 */
export const INTERRUPTED_BY_RESTART = 'interrupted by a restart';

/**
 * Durable home for download records. The queue that schedules a transfer is ephemeral and its
 * jobs are pruned on settle; THIS is what `/gh/jobs/:id` reads, which is why a caller can poll
 * — and fetch the bytes — long after the transfer finished.
 */
export class DownloadStore {
  private readonly records = new Map<string, DownloadRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: StoreOptions) {}

  get dir(): string { return this.opts.dir; }

  /** The store's clock. `transfer` stamps completion times with it so a test's injected
   *  clock governs those too, rather than transfer reaching for `Date.now()` of its own. */
  nowMs(): number { return this.opts.now(); }

  /** `<id>.part` while transferring, `<id>.bin` once complete. Never a remote-supplied name. */
  partPath(id: string): string {
    if (!ID.test(id)) throw new Error(`invalid id: ${id}`);
    return join(this.opts.dir, `${id}.part`);
  }
  filePath(id: string): string {
    if (!ID.test(id)) throw new Error(`invalid id: ${id}`);
    return join(this.opts.dir, `${id}.bin`);
  }

  async load(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(join(this.opts.dir, MANIFEST), 'utf8');
    } catch {
      return; // first run
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error('manifest is not an array');
      for (const r of parsed as DownloadRecord[]) {
        // The manifest is a plain file an operator can edit, and nothing downstream re-checks
        // the id it hands to `filePath`/`partPath` — those throw, from inside a request
        // handler and from the sweep. Admitting an id we could never have minted turns a
        // hand-edited manifest into a 500 on an unrelated request, so drop it here instead.
        if (r && typeof r.id === 'string' && !ID.test(r.id)) {
          log.warn('dropping a downloads manifest record whose id is not a usable filename', { id: r.id });
          continue;
        }
        if (r && typeof r.id === 'string') {
          // Nothing can be mid-transfer across a restart: the process that owned it is gone.
          // Demote so a stale `running` cannot block dedupe or survive a sweep forever.
          this.records.set(r.id, isSettled(r.state) ? r : { ...r, state: 'failed', error: { code: 'cancelled', message: INTERRUPTED_BY_RESTART }, completedAt: this.opts.now() });
        }
      }
    } catch (e: unknown) {
      // A corrupt manifest must not stop the daemon starting. The files are still on disk and
      // the sweep will not know about them, which is a leak we accept over a refusal to boot.
      log.warn('downloads manifest unreadable, starting empty', { message: e instanceof Error ? e.message : String(e) });
      this.records.clear();
    }
  }

  get(id: string): DownloadRecord | undefined { return this.records.get(id); }
  all(): DownloadRecord[] { return [...this.records.values()]; }

  /** An unsettled record for this exact target, or undefined. The dedupe key. */
  findOpen(session: string, url: string): DownloadRecord | undefined {
    for (const r of this.records.values()) {
      if (!isSettled(r.state) && r.session === session && r.url === url) return r;
    }
    return undefined;
  }

  /**
   * A settled-`failed` record for this exact target that a fresh request may TAKE OVER instead
   * of minting a new id — or undefined, which means "start a new download".
   *
   * Without this, `transfer`'s promise that a failure keeps its partial is one the system
   * cannot keep. `findOpen` refuses a settled record, so a re-POST after a mid-body drop mints
   * a new id and a new `.part`, the kept bytes are orphaned disk until the sweep, and a 40GB
   * download restarts from zero after a blip. The only other caller of the resume path is
   * `requeueInterrupted`, which fires once at startup and by design refuses real failures.
   *
   * All four conditions matter:
   *
   *   - `failed`, never `cancelled`. The caller asked for a cancel and its partial is already
   *     gone; folding a later request onto that record would resurrect something it retired.
   *   - code `network`, never `http-error` or `disk-full`. Those are permanent as far as we can
   *     tell — a 404, a refused 206, a full disk — and a retry just hits the same wall. This is
   *     also what excludes `load()`'s restart demotion, which carries `cancelled`: that one is
   *     `requeueInterrupted`'s to handle, at startup, and it is not this path's business.
   *   - the `.part` must still exist and be non-empty, or there is nothing to resume FROM and
   *     the reclaim buys nothing over a fresh id.
   *   - same session and same url, because that is what makes it the same download.
   *
   * The newest candidate wins, so a target that failed repeatedly resumes from the furthest
   * partial rather than an older, shorter one. The caller must set the record back to `queued`
   * before it yields: an unsettled record is what makes `findOpen` fold the *next* request onto
   * this same job rather than reclaiming it a second time.
   */
  async findResumable(session: string, url: string): Promise<DownloadRecord | undefined> {
    const candidates = [...this.records.values()]
      .filter((r) => r.state === 'failed' && r.session === session && r.url === url && r.error?.code === 'network')
      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));
    for (const r of candidates) {
      try {
        if ((await stat(this.partPath(r.id))).size > 0) return r;
      } catch { /* no partial: nothing to resume from */ }
    }
    return undefined;
  }

  async create(init: DownloadInit): Promise<DownloadRecord> {
    const t = this.opts.now();
    const rec: DownloadRecord = {
      id: this.opts.idgen(),
      url: init.url,
      session: init.session,
      referer: init.referer,
      suggestedName: null,
      contentType: null,
      size: -1,
      received: 0,
      sha256: null,
      state: 'queued',
      createdAt: t,
      completedAt: null,
      lastAccessAt: t,
    };
    this.records.set(rec.id, rec);
    await this.save();
    return rec;
  }

  async update(id: string, patch: Partial<DownloadRecord>): Promise<DownloadRecord | undefined> {
    const cur = this.records.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.records.set(id, next);
    await this.save();
    return next;
  }

  async touch(id: string): Promise<void> {
    const cur = this.records.get(id);
    if (!cur) return;
    this.records.set(id, { ...cur, lastAccessAt: this.opts.now() });
    await this.save();
  }

  /**
   * Drop the record and both possible files. Returns false if the id was unknown.
   *
   * The unlinks are best-effort. `force` suppresses ENOENT only — an EPERM or EBUSY from an
   * antivirus scanner or a search indexer holding the file is ordinary on Windows, and this
   * runs inside a request handler, where a rejection would escape as an unhandled one. Losing
   * the record while the bytes linger is a leak the retention sweep cannot see; crashing the
   * daemon is worse, so we log and carry on.
   */
  async remove(id: string): Promise<boolean> {
    if (!this.records.delete(id)) return false;
    for (const path of [this.partPath(id), this.filePath(id)]) {
      try {
        await rm(path, { force: true });
      } catch (e: unknown) {
        log.warn('could not delete a download file; the record is gone but the bytes remain', {
          id, path, reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    await this.save();
    return true;
  }

  /**
   * The retention safety net, for a consumer that never calls DELETE. Removes completed
   * records past the TTL, then evicts least-recently-accessed completed records until the
   * directory is under the cap. An unsettled record is never touched, at any age or size.
   */
  async sweep(): Promise<string[]> {
    const now = this.opts.now();
    const removed: string[] = [];

    for (const r of [...this.records.values()]) {
      if (!isReclaimable(r)) continue;
      const since = r.completedAt ?? r.createdAt;
      if (now - since > this.opts.ttlMs) {
        if (await this.remove(r.id)) {
          removed.push(r.id);
        }
      }
    }

    const sized = await Promise.all(
      [...this.records.values()].map(async (r) => ({ r, bytes: await this.bytesOf(r.id) })),
    );
    let total = sized.reduce((n, x) => n + x.bytes, 0);
    if (total <= this.opts.maxBytes) return removed;

    const victims = sized
      .filter((x) => isReclaimable(x.r))
      .sort((a, b) => a.r.lastAccessAt - b.r.lastAccessAt);

    for (const v of victims) {
      if (total <= this.opts.maxBytes) break;
      if (await this.remove(v.r.id)) {
        removed.push(v.r.id);
        total -= v.bytes;
      }
    }
    return removed;
  }

  private async bytesOf(id: string): Promise<number> {
    let n = 0;
    for (const p of [this.filePath(id), this.partPath(id)]) {
      try { n += (await stat(p)).size; } catch { /* absent */ }
    }
    return n;
  }

  /**
   * Atomic: write a sibling tmp then rename over the manifest, so a crash mid-write leaves the
   * previous manifest intact rather than a truncated one. Serialised through `writing` because
   * concurrent transfers update progress from several places at once. Persistence is best-effort;
   * a write failure is logged but does not stop the daemon, degrading the store to in-memory only.
   */
  private save(): Promise<void> {
    this.writing = this.writing.then(async () => {
      const tmp = join(this.opts.dir, `${MANIFEST}.tmp`);
      await writeFile(tmp, JSON.stringify([...this.records.values()]), 'utf8');
      await rename(tmp, join(this.opts.dir, MANIFEST));
    }).catch((e: unknown) => {
      log.warn('could not persist the downloads manifest', { message: e instanceof Error ? e.message : String(e) });
    });
    return this.writing;
  }
}
