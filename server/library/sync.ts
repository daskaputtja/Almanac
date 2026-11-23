import { type Database, transaction } from '../db/database.js';
import { type CatalogSource, SiloError } from '../silo/client.js';
import type { CatalogPageQuery, SiloCatalogItem, SiloLibrary, SiloUser } from '../silo/types.js';

const STATE = {
  fullAt: 'catalog_full_at',
  recentAt: 'catalog_recent_at',
  namesAvailable: 'library_names_available',
  usersAt: 'users_synced_at',
} as const;

const FULL_SYNC_EVERY_MS = 12 * 60 * 60 * 1000;
/** How far back the first recently-added check looks. */
const FIRST_RECENT_WINDOW_MS = 30 * 86_400_000;
/** Re-read a little before the last check, in case Silo dated items slightly earlier. */
const RECENT_OVERLAP_MS = 60 * 60 * 1000;
/** Episodes are only kept for the recently added feed. */
const KEEP_EPISODES_MS = 60 * 86_400_000;
const PAGE_DELAY_MS = 100;

export interface CatalogSyncOptions {
  intervalMs: number;
  log?: (message: string) => void;
}

/**
 * Keeps Almanac's copy of Silo's accounts, library names and catalog.
 *
 * - Accounts and library names are refreshed on every run.
 * - Newly added movies, shows and episodes are fetched on every run.
 * - Every 12 hours, all movies and shows are re-read. This refreshes poster
 *   links (Silo's expire after about a day) and removes deleted items.
 */
export class CatalogSync {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private runCount = 0;
  private readonly log: (message: string) => void;

  constructor(
    private readonly db: Database,
    private readonly source: CatalogSource,
    private readonly options: CatalogSyncOptions,
  ) {
    this.log = options.log ?? console.log;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  get error(): string | null {
    return this.lastError;
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  private setState(key: string, value: string | null): void {
    this.db
      .prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Run every step once. Errors in one step don't stop the others. */
  async syncOnce(): Promise<void> {
    const errors: string[] = [];
    const attempt = async (step: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(`${step}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await attempt('accounts', () => this.syncUsers());
    await attempt('libraries', () => this.syncLibraries());
    await attempt('recently added', () => this.syncRecent());
    const fullAt = this.getState(STATE.fullAt);
    if (!fullAt || Date.now() - Date.parse(fullAt) > FULL_SYNC_EVERY_MS) {
      await attempt('catalog', () => this.syncFull());
    }

    const message = errors.length ? errors.join('; ') : null;
    if (message && message !== this.lastError) this.log(`Catalog sync problem: ${message}`);
    if (!message && this.lastError) this.log('Catalog sync recovered.');
    this.lastError = message;
  }

  async syncUsers(): Promise<void> {
    const users = await this.source.listUsers();
    const now = new Date().toISOString();
    transaction(this.db, () => {
      const upsert = this.db.prepare(
        `INSERT INTO silo_users (id, username, role, enabled, is_owner, created_at, last_active_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username, role = excluded.role, enabled = excluded.enabled,
           is_owner = excluded.is_owner, created_at = excluded.created_at, last_active_at = excluded.last_active_at,
           synced_at = excluded.synced_at`,
      );
      for (const u of users) upsert.run(...userRow(u, now));
      // Accounts deleted in Silo disappear from this table, but their plays
      // (and names) stay in the history.
      this.db.prepare('DELETE FROM silo_users WHERE synced_at < ?').run(now);
    });
    this.setState(STATE.usersAt, now);
  }

  async syncLibraries(): Promise<void> {
    let libraries: SiloLibrary[];
    try {
      libraries = await this.source.listLibraries();
    } catch (err) {
      if (err instanceof SiloError && err.status === 403) {
        if (this.getState(STATE.namesAvailable) !== '0') {
          this.log('The Silo API key lacks the libraries:read scope, so library names will show as numbers.');
        }
        this.setState(STATE.namesAvailable, '0');
        return;
      }
      throw err;
    }
    const now = new Date().toISOString();
    transaction(this.db, () => {
      const upsert = this.db.prepare(
        `INSERT INTO libraries (id, name, type, sort_order, synced_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, type = excluded.type, sort_order = excluded.sort_order,
           synced_at = excluded.synced_at`,
      );
      for (const l of libraries) upsert.run(l.id, l.name, l.type ?? null, l.sort_order ?? null, now);
      this.db.prepare('DELETE FROM libraries WHERE synced_at < ?').run(now);
    });
    this.setState(STATE.namesAvailable, '1');
  }

  /** Fetch movies, shows and episodes added since the last check. */
  async syncRecent(): Promise<void> {
    const startedAt = Date.now();
    const last = this.getState(STATE.recentAt);
    const since = new Date(last ? Date.parse(last) - RECENT_OVERLAP_MS : startedAt - FIRST_RECENT_WINDOW_MS).toISOString();
    for (const type of ['movie', 'series', 'episode'] as const) {
      await this.walk({ type, addedAfter: since }, new Date().toISOString());
    }
    this.db.prepare("DELETE FROM catalog_items WHERE type = 'episode' AND added_at < ?").run(
      new Date(startedAt - KEEP_EPISODES_MS).toISOString(),
    );
    this.setState(STATE.recentAt, new Date(startedAt).toISOString());
  }

  /** Re-read every movie and show, then drop the ones Silo no longer has. */
  async syncFull(): Promise<void> {
    // A unique marker for this run: every movie and show seen gets it, and
    // anything without it afterwards was not seen, so Silo no longer has it.
    const runMarker = `${new Date().toISOString()}#${(++this.runCount).toString(36)}`;
    const isFirst = !this.getState(STATE.fullAt);
    if (isFirst) this.log('Copying the Silo catalog. On a large server this takes a few minutes.');
    let count = 0;
    for (const type of ['movie', 'series'] as const) {
      if (!this.isActive()) return;
      count += await this.walk({ type }, runMarker);
    }
    if (!this.isActive()) return; // stopped part-way: don't delete what we didn't get to
    this.db.prepare("DELETE FROM catalog_items WHERE type IN ('movie', 'series') AND synced_at <> ?").run(runMarker);
    this.setState(STATE.fullAt, new Date().toISOString());
    if (isFirst) this.log(`Catalog copied: ${count.toLocaleString('en')} movies and shows.`);
  }

  private async walk(query: Omit<CatalogPageQuery, 'cursor'>, syncedAt: string): Promise<number> {
    let cursor: string | undefined;
    let count = 0;
    for (let page = 0; page < 10_000 && this.isActive(); page++) {
      const result = await this.source.listCatalogPage({ ...query, cursor });
      this.upsertItems(result.items, syncedAt);
      count += result.items.length;
      cursor = result.page?.has_more ? result.page.next_cursor : undefined;
      if (!cursor) break;
      await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
    }
    return count;
  }

  /** While started, stop walking when stopped; when called directly (tests), always run. */
  private isActive(): boolean {
    return this.running || this.timer === null;
  }

  private upsertItems(items: SiloCatalogItem[], syncedAt: string): void {
    if (!items.length) return;
    const statement = this.db.prepare(
      `INSERT INTO catalog_items (content_id, type, title, year, series_id, series_title, season_number, episode_number,
         library_ids, added_at, poster_url, genres, rating_imdb, rating_tmdb, resolution, dynamic_range, codec_video,
         file_size, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_id) DO UPDATE SET type = excluded.type, title = excluded.title, year = excluded.year,
         series_id = excluded.series_id, series_title = excluded.series_title, season_number = excluded.season_number,
         episode_number = excluded.episode_number, library_ids = excluded.library_ids, added_at = excluded.added_at,
         poster_url = excluded.poster_url, genres = excluded.genres, rating_imdb = excluded.rating_imdb,
         rating_tmdb = excluded.rating_tmdb, resolution = excluded.resolution, dynamic_range = excluded.dynamic_range,
         codec_video = excluded.codec_video, file_size = excluded.file_size, synced_at = excluded.synced_at`,
    );
    transaction(this.db, () => {
      for (const item of items) {
        const best = bestVersion(item);
        statement.run(
          item.content_id,
          item.type,
          item.title ?? '',
          item.year ?? null,
          item.series_id ?? null,
          item.series_title ?? null,
          item.season_number ?? null,
          item.episode_number ?? null,
          JSON.stringify((item.library_ids ?? []).map(String)),
          item.added_at,
          item.poster_url ?? null,
          item.genres?.length ? JSON.stringify(item.genres) : null,
          item.rating_imdb ?? null,
          item.rating_tmdb ?? null,
          best?.resolution ?? null,
          best?.dynamic_range ?? null,
          best?.codec_video ?? null,
          item.versions?.reduce((sum, v) => sum + (v.file_size ?? 0), 0) || null,
          syncedAt,
        );
      }
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.syncOnce();
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, this.options.intervalMs);
      });
    }
  }
}

function userRow(u: SiloUser, now: string) {
  return [
    String(u.id),
    u.username ?? '',
    u.role ?? null,
    u.enabled == null ? null : u.enabled ? 1 : 0,
    u.is_owner ? 1 : 0,
    u.created_at ?? null,
    u.last_active_at ?? null,
    now,
  ] as const;
}

const RESOLUTION_RANK: Record<string, number> = { '4320p': 5, '2160p': 4, '1440p': 3, '1080p': 2, '720p': 1 };

/** The highest-quality file of an item, for the 4K/HDR badges. */
function bestVersion(item: SiloCatalogItem) {
  return [...(item.versions ?? [])].sort(
    (a, b) => (RESOLUTION_RANK[b.resolution ?? ''] ?? 0) - (RESOLUTION_RANK[a.resolution ?? ''] ?? 0),
  )[0];
}

export const CATALOG_STATE = STATE;
