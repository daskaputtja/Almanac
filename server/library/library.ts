import type { SQLInputValue } from 'node:sqlite';
import type { LibrariesResponse, LibrarySummary, RecentlyAddedItem } from '../../shared/library.js';
import type { Database } from '../db/database.js';
import { CATALOG_STATE, type CatalogSync } from './sync.js';

const CACHE_MS = 60_000;

interface ItemRow {
  content_id: string;
  type: string;
  title: string;
  year: number | null;
  series_id: string | null;
  series_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  library_ids: string;
  added_at: string;
  poster_url: string | null;
  genres: string | null;
  rating_imdb: number | null;
  resolution: string | null;
  dynamic_range: string | null;
}

export interface RecentQuery {
  libraryId?: string;
  kind?: 'movie' | 'show';
  days?: number;
  limit?: number;
}

export class LibraryService {
  private cache: { at: number; value: LibrariesResponse } | null = null;

  constructor(
    private readonly db: Database,
    private readonly sync: CatalogSync,
  ) {}

  libraries(): LibrariesResponse {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) {
      return { ...this.cache.value, status: this.status() };
    }

    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

    const counts = this.db
      .prepare(
        `SELECT j.value AS id,
                SUM(c.type = 'movie') AS movies,
                SUM(c.type = 'series') AS shows,
                SUM(c.added_at >= ?) AS added
         FROM catalog_items c, json_each(c.library_ids) j
         GROUP BY j.value`,
      )
      .all(weekAgo) as { id: string; movies: number; shows: number; added: number }[];

    const playsByLib = this.playsPerLibrary(monthAgo);

    const named = this.db.prepare('SELECT id, name, type, sort_order FROM libraries').all() as {
      id: string;
      name: string;
      type: string | null;
      sort_order: number | null;
    }[];
    const names = new Map(named.map((l) => [l.id, l]));
    const ids = new Set([...counts.map((c) => c.id), ...named.map((l) => l.id)]);

    const libraries: LibrarySummary[] = [...ids].map((id) => {
      const c = counts.find((row) => row.id === id);
      const meta = names.get(id);
      const movies = c?.movies ?? 0;
      const shows = c?.shows ?? 0;
      return {
        id,
        name: meta?.name ?? `Library ${id}`,
        type: meta?.type ?? (movies >= shows ? 'movies' : 'series'),
        movies,
        shows,
        addedLastWeek: c?.added ?? 0,
        playsLast30Days: playsByLib.get(id) ?? 0,
      };
    });
    libraries.sort((a, b) => {
      const sa = names.get(a.id)?.sort_order ?? Number.MAX_SAFE_INTEGER;
      const sb = names.get(b.id)?.sort_order ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    const totals = this.db
      .prepare("SELECT SUM(type = 'movie') AS movies, SUM(type = 'series') AS shows FROM catalog_items")
      .get() as { movies: number | null; shows: number | null };

    const value: LibrariesResponse = {
      libraries,
      totals: { movies: totals.movies ?? 0, shows: totals.shows ?? 0 },
      status: this.status(),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  /**
   * Plays per library since `since`. Movies match the catalog by id and
   * episodes match their show by title. Plays are grouped first, so the
   * catalog is only looked up once per title rather than once per play.
   */
  private playsPerLibrary(since: string): Map<string, number> {
    const groups = this.db
      .prepare(
        `SELECT media_type AS type, CASE WHEN media_type = 'movie' THEN media_item_id ELSE series_title END AS ref,
                COUNT(*) AS plays
         FROM plays WHERE started_at >= ? AND media_type IN ('movie', 'episode') GROUP BY type, ref`,
      )
      .all(since) as { type: string; ref: string | null; plays: number }[];

    const movieLibs = this.db.prepare("SELECT library_ids FROM catalog_items WHERE content_id = ? AND type = 'movie'");
    const showLibs = this.db.prepare("SELECT library_ids FROM catalog_items WHERE type = 'series' AND title = ?");
    const result = new Map<string, number>();

    for (const g of groups) {
      if (!g.ref) continue;
      const rows = (g.type === 'movie' ? movieLibs.all(g.ref) : showLibs.all(g.ref)) as { library_ids: string }[];
      const libs = new Set(rows.flatMap((r) => parseJson<string[]>(r.library_ids) ?? []));
      for (const lib of libs) result.set(lib, (result.get(lib) ?? 0) + g.plays);
    }
    return result;
  }

  status(): LibrariesResponse['status'] {
    const fullAt = this.sync.getState(CATALOG_STATE.fullAt);
    return {
      ready: Boolean(fullAt),
      lastFullSyncAt: fullAt,
      lastRecentSyncAt: this.sync.getState(CATALOG_STATE.recentAt),
      libraryNamesAvailable: this.sync.getState(CATALOG_STATE.namesAvailable) !== '0',
      lastError: this.sync.error,
    };
  }

  /**
   * Recently added movies and shows, newest first. New episodes of a show are
   * grouped into one card per show, dated by its newest episode.
   */
  recent(query: RecentQuery = {}): RecentlyAddedItem[] {
    const days = Math.min(60, Math.max(1, query.days ?? 30));
    const limit = Math.min(200, Math.max(1, query.limit ?? 60));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const where = ['added_at >= ?'];
    const params: SQLInputValue[] = [since];
    if (query.libraryId) {
      where.push('EXISTS (SELECT 1 FROM json_each(library_ids) WHERE value = ?)');
      params.push(query.libraryId);
    }
    const types = query.kind === 'movie' ? "('movie')" : query.kind === 'show' ? "('series', 'episode')" : "('movie', 'series', 'episode')";

    const rows = this.db
      .prepare(
        `SELECT * FROM catalog_items WHERE type IN ${types} AND ${where.join(' AND ')}
         ORDER BY added_at DESC LIMIT ?`,
      )
      .all(...params, limit * 20) as unknown as ItemRow[];

    // Shows' posters and details, for grouping episodes.
    const seriesIds = [...new Set(rows.filter((r) => r.type === 'episode' && r.series_id).map((r) => r.series_id!))];
    const seriesRows = seriesIds.length
      ? (this.db
          .prepare(`SELECT * FROM catalog_items WHERE content_id IN (${seriesIds.map(() => '?').join(',')})`)
          .all(...seriesIds) as unknown as ItemRow[])
      : [];
    const series = new Map(seriesRows.map((s) => [s.content_id, s]));

    const items: RecentlyAddedItem[] = [];
    // One card per show: a new show and its new episodes share a card,
    // placed where the newest of them falls in the list.
    const shows = new Map<string, { item: RecentlyAddedItem; episodes: ItemRow[] }>();
    const showCard = (key: string, make: () => RecentlyAddedItem) => {
      let group = shows.get(key);
      if (!group) {
        group = { item: make(), episodes: [] };
        shows.set(key, group);
        items.push(group.item);
      }
      return group;
    };

    for (const row of rows) {
      if (row.type === 'episode') {
        const show = row.series_id ? series.get(row.series_id) : undefined;
        const group = showCard(`show:${row.series_id ?? row.series_title}`, () => ({
          id: `show:${row.series_id ?? row.series_title}`,
          kind: 'episodes',
          title: row.series_title ?? show?.title ?? 'Unknown show',
          year: show?.year ?? null,
          posterUrl: show?.poster_url ?? row.poster_url,
          addedAt: row.added_at,
          libraryIds: parseJson<string[]>(row.library_ids) ?? [],
          resolution: row.resolution,
          dynamicRange: row.dynamic_range,
          ratingImdb: show?.rating_imdb ?? null,
          genres: parseJson<string[]>(show?.genres ?? null) ?? [],
        }));
        group.episodes.push(row);
      } else if (row.type === 'series') {
        const group = showCard(`show:${row.content_id}`, () => ({
          id: `show:${row.content_id}`,
          kind: 'show',
          title: row.title,
          year: row.year,
          posterUrl: row.poster_url,
          addedAt: row.added_at,
          libraryIds: parseJson<string[]>(row.library_ids) ?? [],
          resolution: null,
          dynamicRange: null,
          ratingImdb: row.rating_imdb,
          genres: parseJson<string[]>(row.genres) ?? [],
        }));
        group.item.isNewShow = true;
        group.item.kind = 'show';
        group.item.year = row.year ?? group.item.year;
        group.item.posterUrl = row.poster_url ?? group.item.posterUrl;
      } else {
        items.push({
          id: row.content_id,
          kind: 'movie',
          title: row.title,
          year: row.year,
          posterUrl: row.poster_url,
          addedAt: row.added_at,
          libraryIds: parseJson<string[]>(row.library_ids) ?? [],
          resolution: row.resolution,
          dynamicRange: row.dynamic_range,
          ratingImdb: row.rating_imdb,
          genres: parseJson<string[]>(row.genres) ?? [],
        });
      }
    }

    for (const { item, episodes } of shows.values()) {
      if (!episodes.length) continue;
      item.episodeCount = episodes.length;
      item.episodeRange = episodeRange(episodes);
      // Show the best quality among the new episodes.
      const best = episodes.find((e) => e.resolution === '2160p') ?? episodes[0]!;
      item.resolution ??= best.resolution;
      item.dynamicRange ??= best.dynamic_range;
    }

    return items.slice(0, limit);
  }
}

/** "S2 E4", "S2 E4–E7", or "S1 E9 – S2 E2" for a set of episodes. */
export function episodeRange(episodes: { season_number: number | null; episode_number: number | null }[]): string {
  const sorted = episodes
    .filter((e) => e.season_number != null || e.episode_number != null)
    .sort((a, b) => (a.season_number ?? 0) - (b.season_number ?? 0) || (a.episode_number ?? 0) - (b.episode_number ?? 0));
  if (!sorted.length) return `${episodes.length} ${episodes.length === 1 ? 'episode' : 'episodes'}`;
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const code = (e: typeof first) => `S${e.season_number ?? '?'} E${e.episode_number ?? '?'}`;
  if (sorted.length === 1) return code(first);
  if (first.season_number === last.season_number) return `${code(first)}–E${last.episode_number ?? '?'}`;
  return `${code(first)} – ${code(last)}`;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
