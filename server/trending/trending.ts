import type { TrendingItem, TrendingResponse } from '../../shared/trending.js';
import type { Database } from '../db/database.js';

const CACHE_MS = 5 * 60_000;
const DAY = 86_400_000;
const COUNTED = '(watched_seconds IS NULL OR watched_seconds >= 120)';
/** Rising needs at least this many viewers this week, so one person's binge can't trend. */
const MIN_VIEWERS = 3;
const LIMIT = 12;

interface Row {
  kind: 'movie' | 'show';
  ref: string;
  title: string;
  viewers: number;
  plays: number;
  prev_viewers: number;
}

/** What's popular, rising and being binged, from the last two weeks of plays. */
export class TrendingService {
  private cache: { at: number; value: TrendingResponse } | null = null;

  constructor(private readonly db: Database) {}

  get(now = Date.now()): TrendingResponse {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value;
    const weekAgo = new Date(now - 7 * DAY).toISOString();
    const twoWeeksAgo = new Date(now - 14 * DAY).toISOString();

    const rows = this.db
      .prepare(
        `SELECT kind, ref, MAX(title) AS title,
                COUNT(DISTINCT CASE WHEN started_at >= ? THEN user_id END) AS viewers,
                SUM(started_at >= ?) AS plays,
                COUNT(DISTINCT CASE WHEN started_at < ? THEN user_id END) AS prev_viewers
         FROM (
           SELECT CASE WHEN media_type = 'movie' THEN 'movie' ELSE 'show' END AS kind,
                  CASE WHEN media_type = 'movie' THEN COALESCE(media_item_id, title) ELSE series_title END AS ref,
                  CASE WHEN media_type = 'movie' THEN title ELSE series_title END AS title,
                  user_id, started_at
           FROM plays
           WHERE started_at >= ? AND ${COUNTED} AND (media_type = 'movie' OR (series_title IS NOT NULL AND series_title <> ''))
         ) GROUP BY kind, ref`,
      )
      .all(weekAgo, weekAgo, weekAgo, twoWeeksAgo) as unknown as Row[];

    const item = (r: Row): TrendingItem => {
      const meta = this.catalog(r.kind, r.ref);
      return {
        key: `${r.kind}:${r.ref}`,
        kind: r.kind,
        title: r.title,
        year: meta?.year ?? null,
        posterUrl: meta?.poster_url ?? null,
        viewers: r.viewers,
        plays: r.plays,
        previousViewers: r.prev_viewers,
        changePercent: r.prev_viewers ? Math.round(((r.viewers - r.prev_viewers) / r.prev_viewers) * 100) : null,
      };
    };

    const popular = [...rows]
      .filter((r) => r.viewers > 0)
      .sort((a, b) => b.viewers - a.viewers || b.plays - a.plays)
      .slice(0, LIMIT)
      .map(item);

    // Rising: most extra viewers compared with the week before, weighted
    // towards bigger jumps, and never just one or two people.
    const rising = rows
      .filter((r) => r.viewers >= MIN_VIEWERS && r.viewers > r.prev_viewers * 1.25)
      .map((r) => ({ r, score: (r.viewers - r.prev_viewers) * Math.log2(2 + r.viewers / Math.max(1, r.prev_viewers)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMIT)
      .map(({ r }) => item(r));

    // Binging: shows where viewers got through several episodes each in 48 hours.
    const binging = (
      this.db
        .prepare(
          `SELECT series_title AS ref, COUNT(DISTINCT user_id) AS viewers, COUNT(*) AS plays,
                  COUNT(DISTINCT user_id || ':' || COALESCE(media_item_id, title)) * 1.0 / COUNT(DISTINCT user_id) AS per_viewer
           FROM plays WHERE started_at >= ? AND ${COUNTED} AND media_type = 'episode' AND series_title IS NOT NULL AND series_title <> ''
           GROUP BY series_title HAVING viewers >= 2 AND per_viewer >= 3
           ORDER BY viewers * per_viewer DESC LIMIT ?`,
        )
        .all(new Date(now - 2 * DAY).toISOString(), LIMIT) as { ref: string; viewers: number; plays: number; per_viewer: number }[]
    ).map((r): TrendingItem => {
      const meta = this.catalog('show', r.ref);
      return {
        key: `binge:${r.ref}`,
        kind: 'show',
        title: r.ref,
        year: meta?.year ?? null,
        posterUrl: meta?.poster_url ?? null,
        viewers: r.viewers,
        plays: r.plays,
        previousViewers: 0,
        changePercent: null,
        episodesPerViewer: Math.round(r.per_viewer * 10) / 10,
      };
    });

    const value = { rising, popular, binging };
    this.cache = { at: now, value };
    return value;
  }

  private catalog(kind: 'movie' | 'show', ref: string): { poster_url: string | null; year: number | null } | undefined {
    return (
      kind === 'movie'
        ? this.db.prepare("SELECT poster_url, year FROM catalog_items WHERE content_id = ? AND type = 'movie'").get(ref)
        : this.db.prepare("SELECT poster_url, year FROM catalog_items WHERE type = 'series' AND title = ? LIMIT 1").get(ref)
    ) as { poster_url: string | null; year: number | null } | undefined;
  }
}
