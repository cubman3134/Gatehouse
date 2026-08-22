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
  partPath(id: string): string { return join(this.opts.dir, `${id}.part`); }
  filePath(id: string): string { return join(this.opts.dir, `${id}.bin`); }

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
        if (r && typeof r.id === 'string') {
          // Nothing can be mid-transfer across a restart: the process that owned it is gone.
          // Demote so a stale `running` cannot block dedupe or survive a sweep forever.
          this.records.set(r.id, isSettled(r.state) ? r : { ...r, state: 'failed', error: { code: 'cancelled', message: 'interrupted by a restart' } });
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

  /** Drop the record and both possible files. Returns false if the id was unknown. */
  async remove(id: string): Promise<boolean> {
    if (!this.records.delete(id)) return false;
    await rm(this.partPath(id), { force: true });
    await rm(this.filePath(id), { force: true });
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
        await this.remove(r.id);
        removed.push(r.id);
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
      await this.remove(v.r.id);
      removed.push(v.r.id);
      total -= v.bytes;
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
   * concurrent transfers update progress from several places at once.
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
