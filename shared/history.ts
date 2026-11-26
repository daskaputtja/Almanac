import type { ViewerNetwork } from './geo.js';
import type { PlayMethod } from './activity.js';

/** One finished play, as stored in Almanac's database. */
export interface HistoryEntry {
  id: string;
  user: {
    id: string;
    name: string;
    profileName: string | null;
  };
  media: {
    type: string;
    title: string;
    seriesTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    itemId: string | null;
    durationSeconds: number | null;
  };
  startedAt: string;
  endedAt: string;
  /** Seconds actually watched, excluding pauses and seeks. Null when Silo didn't measure it. */
  watchedSeconds: number | null;
  pausedSeconds: number | null;
  startPositionSeconds: number | null;
  endPositionSeconds: number;
  completed: boolean;
  playback: {
    method: PlayMethod;
    videoDecision: string | null;
    audioDecision: string | null;
  };
  client: {
    name: string | null;
    version: string | null;
    platform: string | null;
    ip: string | null;
    deviceId: string | null;
    /** Who operates their network (operator for admins only), when known. */
    network?: ViewerNetwork | null;
  };
  subtitle: { language: string | null; codec: string | null } | null;
  endReason: string | null;
}

export type HistorySort = 'ended' | 'user' | 'title' | 'watched';

export interface HistoryQuery {
  search?: string;
  userId?: string;
  mediaType?: string;
  method?: PlayMethod;
  platform?: string;
  /** Inclusive ISO date-time lower bound on when the play ended. */
  from?: string;
  /** Exclusive ISO date-time upper bound on when the play ended. */
  to?: string;
  /** Hide plays where less than this many seconds were watched. */
  minWatchedSeconds?: number;
  completed?: boolean;
  sort?: HistorySort;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface HistoryPage {
  items: HistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HistoryFilterOptions {
  users: { id: string; name: string; plays: number }[];
  platforms: { value: string; plays: number }[];
}

export interface HistorySyncStatus {
  /** Plays stored in Almanac. */
  totalPlays: number;
  oldestPlayAt: string | null;
  newestPlayAt: string | null;
  import: {
    /** True once Almanac has copied all of Silo's existing history. */
    done: boolean;
    /** Plays fetched so far by the first-time import. */
    imported: number;
    startedAt: string | null;
    finishedAt: string | null;
  };
  lastSyncAt: string | null;
  lastError: string | null;
}
