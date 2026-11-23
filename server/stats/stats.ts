import type { SQLInputValue } from 'node:sqlite';
import type { HourBucket, StatsQuery, StatsResult, TopEntry } from '../../shared/stats.js';
import { cleanClientName } from '../activity/map.js';
import type { Database } from '../db/database.js';

const CACHE_MS = 30_000;
const DEFAULT_LIMIT = 10;

interface TopRow {
  key: string;
  name: string | null;
  plays: number;
  watched: number;
  users: number;
  extra?: number;
}

/**
 * Aggregates the play history for the Statistics page. Results are cached
 * briefly, because a year of history on a busy server is several hundred
 * thousand rows and the page asks for the same numbers repeatedly.
 */
export class StatsService {
  private readonly cache = new Map<string, { at: number; result: StatsResult }>();

  constructor(private readonly db: Database) {}

  get(query: StatsQuery): StatsResult {
    const key = JSON.stringify(query);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;

    const result = this.compute(query);
    this.cache.set(key, { at: Date.now(), result });
    if (this.cache.size > 50) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return result;
  }

  private compute(query: StatsQuery): StatsResult {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.from) {
      where.push('started_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('started_at < ?');
      params.push(query.to);
    }
    if (query.userId) {
      where.push('user_id = ?');
      params.push(query.userId);
    }
    if (query.minWatchedSeconds) {
      where.push('(watched_seconds IS NULL OR watched_seconds >= ?)');
      params.push(query.minWatchedSeconds);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const and = (condition: string) => (where.length ? `${whereSql} AND ${condition}` : `WHERE ${condition}`);
    const limit = Math.min(50, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const order = query.rankBy === 'watched' ? 'watched DESC, plays DESC' : 'plays DESC, watched DESC';

    const totalsRow = this.db
      .prepare(
        `SELECT COUNT(*) AS plays,
                COALESCE(SUM(watched_seconds), 0) AS watched,
                COUNT(DISTINCT user_id) AS users,
                COUNT(DISTINCT CASE WHEN media_type = 'episode' AND series_title IS NOT NULL
                                    THEN 's:' || series_title ELSE 'i:' || COALESCE(media_item_id, title) END) AS titles,
                SUM(play_method = 'direct') AS direct,
                SUM(play_method = 'direct_stream') AS direct_stream,
                SUM(play_method = 'remux') AS remux,
                SUM(play_method = 'transcode') AS transcode
         FROM plays ${whereSql}`,
      )
      .get(...params) as Record<string, number | null>;

    const hours = this.db
      .prepare(
        `SELECT substr(started_at, 1, 13) AS hour,
                COUNT(*) AS plays,
                COALESCE(SUM(watched_seconds), 0) AS watched,
                SUM(play_method = 'direct') AS direct,
                SUM(play_method = 'direct_stream') AS direct_stream,
                SUM(play_method = 'remux') AS remux,
                SUM(play_method = 'transcode') AS transcode
         FROM plays ${whereSql}
         GROUP BY hour ORDER BY hour`,
      )
      .all(...params) as { hour: string; plays: number; watched: number; direct: number; direct_stream: number; remux: number; transcode: number }[];

    const top = (sql: string): TopRow[] => this.db.prepare(sql).all(...params, limit) as unknown as TopRow[];

    const shows = top(
      `SELECT series_title AS key, series_title AS name, COUNT(*) AS plays,
              COALESCE(SUM(watched_seconds), 0) AS watched, COUNT(DISTINCT user_id) AS users,
              COUNT(DISTINCT COALESCE(media_item_id, title)) AS extra
       FROM plays ${and("media_type = 'episode' AND series_title IS NOT NULL AND series_title <> ''")}
       GROUP BY series_title ORDER BY ${order} LIMIT ?`,
    );
    const movies = top(
      `SELECT COALESCE(media_item_id, title) AS key, MAX(title) AS name, COUNT(*) AS plays,
              COALESCE(SUM(watched_seconds), 0) AS watched, COUNT(DISTINCT user_id) AS users
       FROM plays ${and("media_type = 'movie'")}
       GROUP BY key ORDER BY ${order} LIMIT ?`,
    );
    const users = top(
      `SELECT user_id AS key,
              (SELECT p2.username FROM plays p2 WHERE p2.user_id = p.user_id AND p2.username <> ''
               ORDER BY p2.ended_at DESC LIMIT 1) AS name,
              COUNT(*) AS plays, COALESCE(SUM(watched_seconds), 0) AS watched, 1 AS users
       FROM plays p ${whereSql}
       GROUP BY user_id ORDER BY ${order} LIMIT ?`,
    );
    // Clients spell platforms differently ("android-tv", "Android TV"), so
    // fetch extra rows and merge spellings after grouping.
    const rawPlatforms = this.db
      .prepare(
        `SELECT device_platform AS key, device_platform AS name, COUNT(*) AS plays,
                COALESCE(SUM(watched_seconds), 0) AS watched, COUNT(DISTINCT user_id) AS users
         FROM plays ${and("device_platform IS NOT NULL AND device_platform <> ''")}
         GROUP BY device_platform ORDER BY ${order} LIMIT ?`,
      )
      .all(...params, limit * 3) as unknown as TopRow[];
    // Player names are cleaned after grouping (e.g. "Jellyfin+for+Roku"), so
    // fetch extra rows and merge any that clean up to the same name.
    const rawPlayers = this.db
      .prepare(
        `SELECT client_name AS key, client_name AS name, COUNT(*) AS plays,
                COALESCE(SUM(watched_seconds), 0) AS watched, COUNT(DISTINCT user_id) AS users
         FROM plays ${and("client_name IS NOT NULL AND client_name <> ''")}
         GROUP BY client_name ORDER BY ${order} LIMIT ?`,
      )
      .all(...params, limit * 3) as unknown as TopRow[];

    const firstPlay = this.db.prepare('SELECT MIN(started_at) AS first FROM plays').get() as { first: string | null };

    return {
      totals: {
        plays: totalsRow.plays ?? 0,
        watchedSeconds: totalsRow.watched ?? 0,
        users: totalsRow.users ?? 0,
        titles: totalsRow.titles ?? 0,
        byMethod: {
          direct: totalsRow.direct ?? 0,
          direct_stream: totalsRow.direct_stream ?? 0,
          remux: totalsRow.remux ?? 0,
          transcode: totalsRow.transcode ?? 0,
        },
      },
      hours: hours.map((h): HourBucket => [
        h.hour,
        h.plays,
        Math.round(h.watched),
        h.direct ?? 0,
        h.direct_stream ?? 0,
        h.remux ?? 0,
        h.transcode ?? 0,
      ]),
      top: {
        shows: shows.map((r) => entry(r, r.extra ? `${r.extra.toLocaleString('en')} ${r.extra === 1 ? 'episode' : 'episodes'}` : undefined)),
        movies: movies.map((r) => entry(r)),
        users: users.map((r) => entry({ ...r, name: r.name ?? `Deleted user ${r.key}` })),
        platforms: mergeRows(rawPlatforms, platformKey, query.rankBy).slice(0, limit),
        players: mergeRows(rawPlayers, (name) => cleanClientName(name) ?? name, query.rankBy).slice(0, limit),
      },
      firstPlayAt: firstPlay.first,
      generatedAt: new Date().toISOString(),
    };
  }
}

/** For players the cleaned name is the display name; for platforms keep the raw spelling. */
function normalizeDisplay(raw: string, normalized: string): string {
  return normalized.includes(' ') ? normalized : raw;
}

function entry(row: TopRow, detail?: string): TopEntry {
  return {
    key: row.key,
    name: row.name || row.key,
    ...(detail ? { detail } : {}),
    plays: row.plays,
    watchedSeconds: Math.round(row.watched),
    users: row.users,
  };
}

/** "android-tv", "Android TV" and "android_tv" are the same platform. */
export function platformKey(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '-');
}

/**
 * Merge rows whose names mean the same thing. The first (largest) row's
 * spelling wins as the displayed name.
 */
function mergeRows(rows: TopRow[], normalize: (name: string) => string, rankBy: StatsQuery['rankBy']): TopEntry[] {
  const merged = new Map<string, TopEntry>();
  for (const row of rows) {
    const raw = row.name ?? row.key;
    const name = normalize(raw);
    const existing = merged.get(name);
    if (existing) {
      existing.plays += row.plays;
      existing.watchedSeconds += Math.round(row.watched);
      // Users can't be summed exactly across raw names; keep the larger count.
      existing.users = Math.max(existing.users, row.users);
    } else {
      merged.set(name, { key: name, name: raw === name ? name : normalizeDisplay(raw, name), plays: row.plays, watchedSeconds: Math.round(row.watched), users: row.users });
    }
  }
  const byWatched = rankBy === 'watched';
  return [...merged.values()].sort((a, b) =>
    byWatched ? b.watchedSeconds - a.watchedSeconds || b.plays - a.plays : b.plays - a.plays || b.watchedSeconds - a.watchedSeconds,
  );
}
