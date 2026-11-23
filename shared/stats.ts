import type { PlayMethod } from './activity.js';

export type StatsRankBy = 'plays' | 'watched';

export interface StatsQuery {
  /** Inclusive ISO date-time lower bound on when plays started. */
  from?: string;
  /** Exclusive ISO date-time upper bound on when plays started. */
  to?: string;
  userId?: string;
  /** Leave out plays shorter than this, like the History page does. */
  minWatchedSeconds?: number;
  rankBy?: StatsRankBy;
  /** How many entries each top list holds. */
  limit?: number;
}

export interface StatsTotals {
  plays: number;
  watchedSeconds: number;
  users: number;
  titles: number;
  byMethod: Record<PlayMethod, number>;
}

/**
 * Plays per UTC hour, as compact tuples so a year of hours stays small:
 * `[hour, plays, watchedSeconds, direct, directStream, remux, transcode]`
 * where `hour` is `YYYY-MM-DDTHH` in UTC. The dashboard turns these into
 * local days, weeks and hours, so every chart follows the viewer's time zone.
 */
export type HourBucket = [string, number, number, number, number, number, number];

export interface TopEntry {
  /** Stable identifier for the entry (user id, series name, item id…). */
  key: string;
  name: string;
  /** Extra line, e.g. a show's number of episodes watched. */
  detail?: string;
  plays: number;
  watchedSeconds: number;
  users: number;
}

export interface StatsResult {
  totals: StatsTotals;
  hours: HourBucket[];
  top: {
    shows: TopEntry[];
    movies: TopEntry[];
    users: TopEntry[];
    platforms: TopEntry[];
    players: TopEntry[];
  };
  /** The earliest play start in the database, so "All time" knows where to begin. */
  firstPlayAt: string | null;
  generatedAt: string;
}
