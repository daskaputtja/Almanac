import type { HourBucket } from './stats.js';

/** A show or movie in a recap's top list. */
export interface RecapTitle {
  key: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  plays: number;
  watchedSeconds: number;
  /** e.g. "42 episodes" for a show. */
  detail?: string;
}

export interface Recap {
  year: number;
  /** One user's year, or the whole server's. */
  scope: 'user' | 'server';
  user: { id: string; name: string } | null;
  /** Years that have any plays, newest first, for the year picker. */
  availableYears: number[];
  /**
   * Almanac only knows plays since its history begins. If that's after
   * 1 January, the recap covers part of the year and says so.
   */
  coverage: { from: string | null; partial: boolean };

  totals: {
    plays: number;
    watchedSeconds: number;
    titles: number;
    movies: number;
    episodes: number;
    shows: number;
  };
  /** UTC hours with plays, so the dashboard can work in the viewer's time zone. */
  hours: HourBucket[];

  topShows: RecapTitle[];
  topMovies: RecapTitle[];
  topGenres: { genre: string; watchedSeconds: number }[];

  /** Most episodes of one show in a single day. On the server recap, includes who. */
  biggestBinge: { title: string; posterUrl: string | null; episodes: number; date: string; userName?: string } | null;
  /** The longest stretch without a break of more than 10 minutes. */
  longestSitting: { seconds: number; start: string; end: string; titles: number } | null;
  firstPlay: { title: string; at: string } | null;
  lastPlay: { title: string; at: string } | null;
  favouritePlayer: { name: string; plays: number } | null;
  favouritePlatform: { name: string; plays: number } | null;
  directPlayPercent: number | null;

  /** User recap: share of the year's viewers who watched less, 0–100. */
  percentile: number | null;

  /** Server recap only. */
  server: {
    activeUsers: number;
    topUsers: { id: string; name: string; watchedSeconds: number; plays: number }[];
    newMovies: number;
    newShows: number;
  } | null;
}

export interface RecapShare {
  id: string;
  /** The link's path, e.g. "/r/abc…"; the dashboard adds the site address. */
  path: string;
  year: number;
  createdBy: string;
  createdAt: string;
  revoked: boolean;
  views: number;
  lastViewedAt: string | null;
}
