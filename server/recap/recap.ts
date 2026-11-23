import type { SQLInputValue } from 'node:sqlite';
import type { Recap, RecapTitle } from '../../shared/recap.js';
import type { HourBucket } from '../../shared/stats.js';
import { cleanClientName } from '../activity/map.js';
import type { Database } from '../db/database.js';
import { platformKey } from '../stats/stats.js';

const CACHE_MS = 10 * 60_000;
const COUNTED = '(watched_seconds IS NULL OR watched_seconds >= 30)';
const TOP = 5;
/** Plays closer together than this count as one sitting. */
const SITTING_GAP_MS = 10 * 60_000;

export class RecapError extends Error {}

/**
 * A year in review, for one user or the whole server, built from Almanac's
 * play history and catalog copy. Cached for 10 minutes: a server-wide year
 * reads every play of the year.
 */
export class RecapService {
  private readonly cache = new Map<string, { at: number; recap: Recap }>();

  constructor(private readonly db: Database) {}

  get(year: number, userId: string | null): Recap {
    const key = `${year}:${userId ?? '*'}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.recap;
    const recap = this.build(year, userId);
    this.cache.set(key, { at: Date.now(), recap });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return recap;
  }

  private build(year: number, userId: string | null): Recap {
    const from = `${year}-01-01T00:00:00.000Z`;
    const to = `${year + 1}-01-01T00:00:00.000Z`;
    const where = [`started_at >= ?`, `started_at < ?`, COUNTED];
    const params: SQLInputValue[] = [from, to];
    if (userId) {
      where.push('user_id = ?');
      params.push(userId);
    }
    const W = `WHERE ${where.join(' AND ')}`;
    const all = <T,>(sql: string, ...extra: SQLInputValue[]) => this.db.prepare(sql).all(...params, ...extra) as unknown as T[];
    const one = <T,>(sql: string, ...extra: SQLInputValue[]) => this.db.prepare(sql).get(...params, ...extra) as unknown as T | undefined;

    const userName = userId ? this.userName(userId) : null;
    if (userId && !userName) throw new RecapError('No such user.');

    const totals = one<{ plays: number; watched: number | null; movies: number; episodes: number; shows: number; titles: number; direct: number | null }>(
      `SELECT COUNT(*) AS plays, SUM(watched_seconds) AS watched,
              COUNT(DISTINCT CASE WHEN media_type = 'movie' THEN COALESCE(media_item_id, title) END) AS movies,
              COUNT(DISTINCT CASE WHEN media_type = 'episode' THEN COALESCE(media_item_id, series_title || title) END) AS episodes,
              COUNT(DISTINCT CASE WHEN media_type = 'episode' THEN series_title END) AS shows,
              COUNT(DISTINCT CASE WHEN media_type = 'episode' THEN 's:' || series_title ELSE 'i:' || COALESCE(media_item_id, title) END) AS titles,
              SUM(play_method = 'direct') AS direct
       FROM plays ${W}`,
    )!;

    const hours = all<{ hour: string; plays: number; watched: number; direct: number; ds: number; remux: number; transcode: number }>(
      `SELECT substr(started_at, 1, 13) AS hour, COUNT(*) AS plays, COALESCE(SUM(watched_seconds), 0) AS watched,
              SUM(play_method = 'direct') AS direct, SUM(play_method = 'direct_stream') AS ds,
              SUM(play_method = 'remux') AS remux, SUM(play_method = 'transcode') AS transcode
       FROM plays ${W} GROUP BY hour ORDER BY hour`,
    ).map((h): HourBucket => [h.hour, h.plays, Math.round(h.watched), h.direct, h.ds, h.remux, h.transcode]);

    // Top shows and movies, with posters from the catalog copy.
    const showRows = all<{ title: string; plays: number; watched: number; episodes: number }>(
      `SELECT series_title AS title, COUNT(*) AS plays, COALESCE(SUM(watched_seconds), 0) AS watched,
              COUNT(DISTINCT COALESCE(media_item_id, title)) AS episodes
       FROM plays ${W} AND media_type = 'episode' AND series_title IS NOT NULL AND series_title <> ''
       GROUP BY series_title ORDER BY watched DESC, plays DESC LIMIT ?`,
      TOP,
    );
    const movieRows = all<{ id: string; title: string; plays: number; watched: number }>(
      `SELECT COALESCE(media_item_id, title) AS id, MAX(title) AS title, COUNT(*) AS plays, COALESCE(SUM(watched_seconds), 0) AS watched
       FROM plays ${W} AND media_type = 'movie' GROUP BY id ORDER BY watched DESC, plays DESC LIMIT ?`,
      TOP,
    );
    const show = this.db.prepare("SELECT poster_url, year, genres FROM catalog_items WHERE type = 'series' AND title = ? LIMIT 1");
    const movie = this.db.prepare("SELECT poster_url, year, genres FROM catalog_items WHERE content_id = ? AND type = 'movie'");
    type CatalogRow = { poster_url: string | null; year: number | null; genres: string | null };
    const topShows: RecapTitle[] = showRows.map((r) => {
      const c = show.get(r.title) as CatalogRow | undefined;
      return {
        key: r.title,
        title: r.title,
        year: c?.year ?? null,
        posterUrl: c?.poster_url ?? null,
        plays: r.plays,
        watchedSeconds: Math.round(r.watched),
        detail: `${r.episodes.toLocaleString('en')} ${r.episodes === 1 ? 'episode' : 'episodes'}`,
      };
    });
    const topMovies: RecapTitle[] = movieRows.map((r) => {
      const c = movie.get(r.id) as CatalogRow | undefined;
      return {
        key: r.id,
        title: r.title,
        year: c?.year ?? null,
        posterUrl: c?.poster_url ?? null,
        plays: r.plays,
        watchedSeconds: Math.round(r.watched),
        detail: r.plays > 1 ? `watched ${r.plays} times` : undefined,
      };
    });

    // Genres, weighted by time watched. Plays are grouped first so the catalog
    // is looked up once per title.
    const genreGroups = all<{ type: string; ref: string | null; watched: number }>(
      `SELECT media_type AS type, CASE WHEN media_type = 'movie' THEN media_item_id ELSE series_title END AS ref,
              COALESCE(SUM(watched_seconds), 0) AS watched
       FROM plays ${W} AND media_type IN ('movie', 'episode') GROUP BY type, ref`,
    );
    const genreTotals = new Map<string, number>();
    for (const g of genreGroups) {
      if (!g.ref) continue;
      const c = (g.type === 'movie' ? movie.get(g.ref) : show.get(g.ref)) as CatalogRow | undefined;
      for (const genre of parseList(c?.genres ?? null)) genreTotals.set(genre, (genreTotals.get(genre) ?? 0) + g.watched);
    }
    const topGenres = [...genreTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([genre, watched]) => ({ genre, watchedSeconds: Math.round(watched) }));

    const binge = one<{ title: string; date: string; episodes: number; user_id: string }>(
      `SELECT series_title AS title, substr(started_at, 1, 10) AS date, user_id,
              COUNT(DISTINCT COALESCE(media_item_id, title)) AS episodes
       FROM plays ${W} AND media_type = 'episode' AND series_title IS NOT NULL AND series_title <> ''
       GROUP BY user_id, series_title, date ORDER BY episodes DESC LIMIT 1`,
    );
    const biggestBinge =
      binge && binge.episodes > 1
        ? {
            title: binge.title,
            posterUrl: (show.get(binge.title) as CatalogRow | undefined)?.poster_url ?? null,
            episodes: binge.episodes,
            date: binge.date,
            ...(userId ? {} : { userName: this.userName(binge.user_id) ?? `User ${binge.user_id}` }),
          }
        : null;

    const label = (r: { title: string; series_title: string | null; media_type: string }) =>
      r.media_type === 'episode' && r.series_title ? `${r.series_title}: ${r.title}` : r.title;
    const first = one<{ title: string; series_title: string | null; media_type: string; started_at: string }>(
      `SELECT title, series_title, media_type, started_at FROM plays ${W} ORDER BY started_at LIMIT 1`,
    );
    const last = one<{ title: string; series_title: string | null; media_type: string; started_at: string }>(
      `SELECT title, series_title, media_type, started_at FROM plays ${W} ORDER BY started_at DESC LIMIT 1`,
    );

    const players = all<{ name: string; plays: number }>(
      `SELECT client_name AS name, COUNT(*) AS plays FROM plays ${W} AND client_name IS NOT NULL AND client_name <> ''
       GROUP BY client_name ORDER BY plays DESC LIMIT 20`,
    );
    const platforms = all<{ name: string; plays: number }>(
      `SELECT device_platform AS name, COUNT(*) AS plays FROM plays ${W} AND device_platform IS NOT NULL AND device_platform <> ''
       GROUP BY device_platform ORDER BY plays DESC LIMIT 20`,
    );

    // Longest sitting (one user only: on the whole server it would just be "always").
    let longestSitting: Recap['longestSitting'] = null;
    if (userId) {
      const spans = all<{ s: string; e: string }>(`SELECT started_at AS s, ended_at AS e FROM plays ${W} ORDER BY started_at`);
      let run: { start: number; end: number; titles: number } | null = null;
      const consider = () => {
        if (run && (!longestSitting || run.end - run.start > longestSitting.seconds * 1000)) {
          longestSitting = { seconds: Math.round((run.end - run.start) / 1000), start: new Date(run.start).toISOString(), end: new Date(run.end).toISOString(), titles: run.titles };
        }
      };
      for (const { s, e } of spans) {
        const start = Date.parse(s);
        const end = Date.parse(e);
        if (run && start - run.end <= SITTING_GAP_MS) {
          run.end = Math.max(run.end, end);
          run.titles++;
        } else {
          consider();
          run = { start, end, titles: 1 };
        }
      }
      consider();
    }

    // How this user compares with everyone who watched that year.
    let percentile: number | null = null;
    if (userId) {
      const everyone = this.db
        .prepare(`SELECT user_id, COALESCE(SUM(watched_seconds), 0) AS watched FROM plays WHERE started_at >= ? AND started_at < ? AND ${COUNTED} GROUP BY user_id`)
        .all(from, to) as { user_id: string; watched: number }[];
      const mine = everyone.find((u) => u.user_id === userId)?.watched ?? 0;
      if (everyone.length > 1) percentile = Math.round((everyone.filter((u) => u.watched < mine).length / (everyone.length - 1)) * 100);
    }

    let server: Recap['server'] = null;
    if (!userId) {
      const active = one<{ n: number }>(`SELECT COUNT(DISTINCT user_id) AS n FROM plays ${W}`)!;
      const topUsers = all<{ id: string; watched: number; plays: number }>(
        `SELECT user_id AS id, COALESCE(SUM(watched_seconds), 0) AS watched, COUNT(*) AS plays FROM plays ${W}
         GROUP BY user_id ORDER BY watched DESC LIMIT ?`,
        TOP,
      ).map((u) => ({ id: u.id, name: this.userName(u.id) ?? `User ${u.id}`, watchedSeconds: Math.round(u.watched), plays: u.plays }));
      const added = this.db
        .prepare("SELECT type, COUNT(*) AS n FROM catalog_items WHERE added_at >= ? AND added_at < ? AND type IN ('movie', 'series') GROUP BY type")
        .all(from, to) as { type: string; n: number }[];
      server = {
        activeUsers: active.n,
        topUsers,
        newMovies: added.find((a) => a.type === 'movie')?.n ?? 0,
        newShows: added.find((a) => a.type === 'series')?.n ?? 0,
      };
    }

    const historyStart = (this.db.prepare(`SELECT MIN(started_at) AS m FROM plays WHERE ${COUNTED}`).get() as { m: string | null }).m;
    const years = (this.db.prepare("SELECT DISTINCT CAST(substr(started_at, 1, 4) AS INTEGER) AS y FROM plays ORDER BY y DESC").all() as { y: number }[]).map((r) => r.y);

    return {
      year,
      scope: userId ? 'user' : 'server',
      user: userId ? { id: userId, name: userName! } : null,
      availableYears: years,
      coverage: { from: historyStart && historyStart > from ? historyStart : from, partial: Boolean(historyStart && historyStart > from) },
      totals: {
        plays: totals.plays,
        watchedSeconds: Math.round(totals.watched ?? 0),
        titles: totals.titles,
        movies: totals.movies,
        episodes: totals.episodes,
        shows: totals.shows,
      },
      hours,
      topShows,
      topMovies,
      topGenres,
      biggestBinge,
      longestSitting,
      firstPlay: first ? { title: label(first), at: first.started_at } : null,
      lastPlay: last ? { title: label(last), at: last.started_at } : null,
      favouritePlayer: mergeTop(players.map((p) => ({ ...p, name: cleanClientName(p.name) ?? p.name })), (n) => n),
      favouritePlatform: mergeTop(platforms, platformKey),
      directPlayPercent: totals.plays ? Math.round(((totals.direct ?? 0) / totals.plays) * 1000) / 10 : null,
      percentile,
      server,
    };
  }

  private userName(userId: string): string | null {
    const silo = this.db.prepare('SELECT username FROM silo_users WHERE id = ?').get(userId) as { username: string } | undefined;
    if (silo?.username) return silo.username;
    const fromPlays = this.db
      .prepare("SELECT username FROM plays WHERE user_id = ? AND username <> '' ORDER BY ended_at DESC LIMIT 1")
      .get(userId) as { username: string } | undefined;
    return fromPlays?.username ?? null;
  }
}

/** The most-used entry after merging spellings, e.g. "android-tv" and "Android TV". */
function mergeTop(rows: { name: string; plays: number }[], normalize: (name: string) => string): { name: string; plays: number } | null {
  const merged = new Map<string, { name: string; plays: number }>();
  for (const r of rows) {
    const key = normalize(r.name);
    const existing = merged.get(key);
    if (existing) existing.plays += r.plays;
    else merged.set(key, { name: r.name, plays: r.plays });
  }
  return [...merged.values()].sort((a, b) => b.plays - a.plays)[0] ?? null;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
