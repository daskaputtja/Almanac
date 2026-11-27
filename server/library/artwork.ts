import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../db/database.js';
import type { CatalogSource } from '../silo/client.js';

/** A copy is served for this long before Almanac asks Silo again. */
const FRESH_MS = 7 * 86_400_000;
/** Copies nobody has asked for in this long are removed. */
const KEEP_MS = 60 * 86_400_000;
/** At most this many requests to Silo at once (it rate-limits poster requests). */
const MAX_PARALLEL = 4;
const MAX_BYTES = 15 * 1024 * 1024;

export interface ArtworkResult {
  status: 200 | 304 | 404 | 502 | 503;
  body?: Buffer;
  type?: string;
  etag?: string;
  retryAfter?: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Silo's artwork, passed on from Almanac's own address. Silo's poster links
 * are signed and expire, and it limits how fast they can be fetched, so
 * Almanac keeps a copy of each image it has served (in its data folder), and
 * when a stored link has expired it asks Silo for a fresh one for that title.
 */
export class ArtworkService {
  private readonly dir: string;
  private readonly inFlight = new Map<string, Promise<ArtworkResult>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly db: Database,
    dataDir: string,
    private readonly siloUrl: string | null,
    private readonly catalog: CatalogSource | null,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.dir = join(dataDir, 'artwork');
  }

  /** `rest` is the path after /api/artwork/ (e.g. "item-posters/42"), `query` its "?exp=…&sig=…". */
  async get(rest: string, query: string, ifNoneMatch?: string | null): Promise<ArtworkResult> {
    if (!this.siloUrl || !/^(item-posters|artwork)\/[A-Za-z0-9._~%/-]+$/.test(rest) || rest.includes('..')) return { status: 404 };
    const key = createHash('sha1').update(rest).digest('hex');
    const etag = `"a-${key.slice(0, 16)}"`;
    const cached = this.read(key);
    if (cached && Date.now() - cached.at < FRESH_MS) {
      return ifNoneMatch === etag ? { status: 304, etag } : { status: 200, body: cached.body, type: cached.type, etag };
    }
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.fetchAndKeep(rest, query, key).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    const result = await pending;
    if (result.status === 200) return ifNoneMatch === etag ? { status: 304, etag } : { ...result, etag };
    // Silo is busy or the link is gone: an older copy is better than nothing.
    if (cached) return { status: 200, body: cached.body, type: cached.type, etag };
    return result;
  }

  private async fetchAndKeep(rest: string, query: string, key: string): Promise<ArtworkResult> {
    let result = await this.fromSilo(rest, query);
    // An expired poster link: ask Silo for a fresh one for that title, and try once more.
    const poster = rest.match(/^item-posters\/([^/?]+)$/);
    if (result.status === 404 && poster && this.catalog) {
      const fresh = await this.freshPosterLink(decodeURIComponent(poster[1]!));
      if (fresh) result = await this.fromSilo(rest, fresh.slice(fresh.indexOf('?')));
    }
    if (result.status === 200 && result.body) this.write(key, result.body, result.type!);
    return result;
  }

  private async fromSilo(rest: string, query: string): Promise<ArtworkResult> {
    await this.slot();
    try {
      const res = await this.fetchImpl(`${this.siloUrl!.replace(/\/+$/, '')}/api/v2/${rest}${query.startsWith('?') ? query : ''}`, {
        headers: { Accept: 'image/*', 'User-Agent': 'Almanac' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status === 503) {
        return { status: 503, retryAfter: Number(res.headers.get('retry-after')) || 5 };
      }
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) return { status: res.status === 404 ? 404 : 502 };
      if (!/^image\//i.test(type)) return { status: 502 };
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_BYTES) return { status: 502 };
      return { status: 200, body, type };
    } catch {
      return { status: 502 };
    } finally {
      this.release();
    }
  }

  /** A fresh signed poster link for a title from Silo, saved over the expired one. */
  private async freshPosterLink(contentId: string): Promise<string | null> {
    try {
      const page = await this.catalog!.listCatalogPage({ contentIds: [contentId], limit: 1 });
      const link = page.items[0]?.poster_url ?? null;
      if (!link || !link.startsWith('/api/artwork/item-posters/')) return null;
      // Every row using this poster (a show's episodes share it) gets the new link.
      this.db
        .prepare("UPDATE catalog_items SET poster_url = ? WHERE poster_url LIKE '/api/artwork/item-posters/' || ? || '?%'")
        .run(link, contentId);
      return link;
    } catch (err) {
      this.log(`Couldn’t refresh a poster link: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // --- The copies -----------------------------------------------------------------

  private read(key: string): { body: Buffer; type: string; at: number } | null {
    const file = join(this.dir, key.slice(0, 2), key);
    try {
      const meta = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { type: string; at: number };
      return { body: readFileSync(file), ...meta };
    } catch {
      return null;
    }
  }

  private write(key: string, body: Buffer, type: string): void {
    try {
      const folder = join(this.dir, key.slice(0, 2));
      mkdirSync(folder, { recursive: true });
      const file = join(folder, key);
      writeFileSync(`${file}.tmp`, body);
      renameSync(`${file}.tmp`, file);
      writeFileSync(`${file}.json`, JSON.stringify({ type, at: Date.now() }));
      if (Math.random() < 0.01) this.prune();
    } catch (err) {
      this.log(`Couldn’t keep a copy of a poster: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Remove copies nobody has needed in two months. */
  prune(now = Date.now()): number {
    let removed = 0;
    if (!existsSync(this.dir)) return 0;
    for (const folder of readdirSync(this.dir)) {
      for (const name of readdirSync(join(this.dir, folder))) {
        if (name.endsWith('.json') || name.endsWith('.tmp')) continue;
        const file = join(this.dir, folder, name);
        if (now - statSync(file).mtimeMs > KEEP_MS) {
          for (const f of [file, `${file}.json`]) if (existsSync(f)) unlinkSync(f);
          removed++;
        }
      }
    }
    return removed;
  }

  // --- Not too many at once ---------------------------------------------------------

  private async slot(): Promise<void> {
    if (this.active < MAX_PARALLEL) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
