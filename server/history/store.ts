import type { SQLInputValue } from 'node:sqlite';
import type {
  HistoryEntry,
  HistoryFilterOptions,
  HistoryPage,
  HistoryQuery,
  HistorySort,
} from '../../shared/history.js';
import { cleanClientName, normalizePlayMethod } from '../activity/map.js';
import { type Database, transaction } from '../db/database.js';
import type { SiloHistoryEntry } from '../silo/types.js';

interface PlayRow {
  session_id: string;
  user_id: string;
  username: string;
  profile_name: string | null;
  media_item_id: string | null;
  media_type: string;
  title: string;
  series_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  duration_seconds: number | null;
  started_at: string;
  ended_at: string;
  start_position: number | null;
  end_position: number;
  watched_seconds: number | null;
  paused_seconds: number | null;
  completed: number;
  play_method: string;
  video_decision: string | null;
  audio_decision: string | null;
  client_name: string | null;
  client_version: string | null;
  device_platform: string | null;
  device_id: string | null;
  client_ip: string | null;
  subtitle_language: string | null;
  subtitle_codec: string | null;
  end_reason: string | null;
}

const SORT_COLUMNS: Record<HistorySort, string> = {
  ended: 'ended_at',
  user: 'username COLLATE NOCASE',
  title: "COALESCE(NULLIF(series_title, ''), title) COLLATE NOCASE",
  watched: 'COALESCE(watched_seconds, 0)',
};

const MAX_PAGE_SIZE = 100;

/**
 * Upsert used for every play from Silo. When Silo later blanks a field because
 * the account or item was deleted, Almanac keeps the value it already had —
 * that is the point of keeping our own copy.
 */
const UPSERT_SQL = `
  INSERT INTO plays (
    session_id, user_id, username, profile_id, profile_name, media_item_id, media_file_id,
    media_type, title, series_title, season_number, episode_number, duration_seconds,
    started_at, ended_at, start_position, end_position, watched_seconds, paused_seconds,
    completed, play_method, video_decision, audio_decision, client_name, client_version,
    device_platform, device_id, client_ip, subtitle_language, subtitle_codec, end_reason,
    lifecycle_seq, imported_at
  ) VALUES (
    :session_id, :user_id, :username, :profile_id, :profile_name, :media_item_id, :media_file_id,
    :media_type, :title, :series_title, :season_number, :episode_number, :duration_seconds,
    :started_at, :ended_at, :start_position, :end_position, :watched_seconds, :paused_seconds,
    :completed, :play_method, :video_decision, :audio_decision, :client_name, :client_version,
    :device_platform, :device_id, :client_ip, :subtitle_language, :subtitle_codec, :end_reason,
    :lifecycle_seq, :imported_at
  )
  ON CONFLICT (session_id) DO UPDATE SET
    username          = COALESCE(NULLIF(excluded.username, ''), plays.username),
    profile_name      = COALESCE(NULLIF(excluded.profile_name, ''), plays.profile_name),
    media_type        = COALESCE(NULLIF(excluded.media_type, ''), plays.media_type),
    title             = COALESCE(NULLIF(excluded.title, ''), plays.title),
    series_title      = COALESCE(NULLIF(excluded.series_title, ''), plays.series_title),
    media_item_id     = COALESCE(NULLIF(excluded.media_item_id, ''), plays.media_item_id),
    season_number     = COALESCE(excluded.season_number, plays.season_number),
    episode_number    = COALESCE(excluded.episode_number, plays.episode_number),
    duration_seconds  = COALESCE(excluded.duration_seconds, plays.duration_seconds),
    started_at        = excluded.started_at,
    ended_at          = excluded.ended_at,
    start_position    = excluded.start_position,
    end_position      = excluded.end_position,
    watched_seconds   = excluded.watched_seconds,
    paused_seconds    = excluded.paused_seconds,
    completed         = excluded.completed,
    play_method       = excluded.play_method,
    video_decision    = excluded.video_decision,
    audio_decision    = excluded.audio_decision,
    client_name       = excluded.client_name,
    client_version    = excluded.client_version,
    device_platform   = excluded.device_platform,
    device_id         = excluded.device_id,
    client_ip         = excluded.client_ip,
    subtitle_language = excluded.subtitle_language,
    subtitle_codec    = excluded.subtitle_codec,
    end_reason        = excluded.end_reason,
    lifecycle_seq     = excluded.lifecycle_seq
  WHERE excluded.lifecycle_seq IS NULL
     OR plays.lifecycle_seq IS NULL
     OR excluded.lifecycle_seq >= plays.lifecycle_seq
`;

export class HistoryStore {
  constructor(private readonly db: Database) {}

  /** Insert or update plays from Silo in one transaction. Returns how many were written. */
  upsert(entries: SiloHistoryEntry[]): number {
    if (!entries.length) return 0;
    const statement = this.db.prepare(UPSERT_SQL);
    const importedAt = new Date().toISOString();

    return transaction(this.db, () => {
      for (const e of entries) {
        statement.run({
          session_id: e.session_id,
          user_id: e.user_id,
          username: e.username ?? '',
          profile_id: e.profile_id,
          profile_name: e.profile_name || null,
          media_item_id: e.media_item_id || null,
          media_file_id: e.media_file_id || null,
          media_type: e.media_type ?? '',
          title: e.media_title ?? '',
          series_title: e.series_title || null,
          season_number: e.season_number ?? null,
          episode_number: e.episode_number ?? null,
          duration_seconds: e.duration_seconds ?? null,
          started_at: e.started_at,
          ended_at: e.ended_at,
          start_position: e.start_position_seconds ?? null,
          end_position: e.end_position_seconds ?? 0,
          watched_seconds: e.measured ? (e.played_seconds ?? null) : null,
          paused_seconds: e.measured ? (e.paused_seconds ?? null) : null,
          completed: e.completed ? 1 : 0,
          play_method: normalizePlayMethod(e.play_method),
          video_decision: e.video_decision ?? null,
          audio_decision: e.audio_decision ?? null,
          client_name: e.client_name ?? null,
          client_version: e.client_version ?? null,
          device_platform: e.device_platform ?? null,
          device_id: e.device_id ?? null,
          client_ip: e.client_ip ?? null,
          subtitle_language: e.subtitle?.language || null,
          subtitle_codec: e.subtitle?.codec || null,
          end_reason: e.end_reason ?? null,
          lifecycle_seq: e.lifecycle_seq ?? null,
          imported_at: importedAt,
        });
      }
      return entries.length;
    });
  }

  query(query: HistoryQuery = {}): HistoryPage {
    const where: string[] = [];
    const params: SQLInputValue[] = [];

    const search = query.search?.trim();
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        `(title LIKE ? ESCAPE '\\' OR series_title LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\'
          OR client_name LIKE ? ESCAPE '\\' OR client_ip LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like, like, like);
    }
    if (query.userId) {
      where.push('user_id = ?');
      params.push(query.userId);
    }
    if (query.mediaType) {
      where.push('media_type = ?');
      params.push(query.mediaType);
    }
    if (query.method) {
      where.push('play_method = ?');
      params.push(query.method);
    }
    if (query.platform) {
      where.push('device_platform = ?');
      params.push(query.platform);
    }
    if (query.from) {
      where.push('ended_at >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('ended_at < ?');
      params.push(query.to);
    }
    if (query.minWatchedSeconds) {
      // Unmeasured plays are kept, since we can't tell how long they were.
      where.push('(watched_seconds IS NULL OR watched_seconds >= ?)');
      params.push(query.minWatchedSeconds);
    }
    if (query.completed !== undefined) {
      where.push('completed = ?');
      params.push(query.completed ? 1 : 0);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 50)));
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const sortColumn = SORT_COLUMNS[query.sort ?? 'ended'] ?? SORT_COLUMNS.ended;

    const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM plays ${whereSql}`).get(...params) as {
      total: number;
    };
    const rows = this.db
      .prepare(
        `SELECT * FROM plays ${whereSql}
         ORDER BY ${sortColumn} ${direction}, ended_at DESC, session_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as unknown as PlayRow[];

    return { items: rows.map(toHistoryEntry), total, page, pageSize };
  }

  filterOptions(): HistoryFilterOptions {
    const users = this.db
      .prepare(
        `SELECT user_id AS id,
                (SELECT p2.username FROM plays p2 WHERE p2.user_id = p.user_id AND p2.username <> ''
                 ORDER BY p2.ended_at DESC LIMIT 1) AS name,
                COUNT(*) AS plays
         FROM plays p GROUP BY user_id ORDER BY name COLLATE NOCASE`,
      )
      .all() as { id: string; name: string | null; plays: number }[];
    const platforms = this.db
      .prepare(
        `SELECT device_platform AS value, COUNT(*) AS plays FROM plays
         WHERE device_platform IS NOT NULL AND device_platform <> ''
         GROUP BY device_platform ORDER BY plays DESC`,
      )
      .all() as { value: string; plays: number }[];

    return {
      users: users.map((u) => ({ id: u.id, name: u.name ?? `Deleted user ${u.id}`, plays: u.plays })),
      platforms,
    };
  }

  stats(): { total: number; oldest: string | null; newest: string | null } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total, MIN(ended_at) AS oldest, MAX(ended_at) AS newest FROM plays')
      .get() as { total: number; oldest: string | null; newest: string | null };
    return row;
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string | null): void {
    this.db
      .prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}

function toHistoryEntry(r: PlayRow): HistoryEntry {
  return {
    id: r.session_id,
    user: {
      id: r.user_id,
      name: r.username || `Deleted user ${r.user_id}`,
      profileName: r.profile_name,
    },
    media: {
      type: r.media_type,
      title: r.title || 'Unknown title',
      seriesTitle: r.series_title,
      seasonNumber: r.season_number,
      episodeNumber: r.episode_number,
      itemId: r.media_item_id,
      durationSeconds: r.duration_seconds,
    },
    startedAt: r.started_at,
    endedAt: r.ended_at,
    watchedSeconds: r.watched_seconds,
    pausedSeconds: r.paused_seconds,
    startPositionSeconds: r.start_position,
    endPositionSeconds: r.end_position,
    completed: r.completed === 1,
    playback: {
      method: normalizePlayMethod(r.play_method),
      videoDecision: r.video_decision,
      audioDecision: r.audio_decision,
    },
    client: {
      name: cleanClientName(r.client_name),
      version: r.client_version,
      platform: r.device_platform,
      ip: r.client_ip,
      deviceId: r.device_id,
    },
    subtitle: r.subtitle_language || r.subtitle_codec ? { language: r.subtitle_language, codec: r.subtitle_codec } : null,
    endReason: r.end_reason,
  };
}
