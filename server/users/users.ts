import type { UserDetail, UserSummary } from '../../shared/users.js';
import { cleanClientName } from '../activity/map.js';
import type { Database } from '../db/database.js';
import { platformKey } from '../stats/stats.js';

const CACHE_MS = 60_000;
/** Same rule as History and Statistics: very short plays don't count. */
const MIN_WATCHED_SECONDS = 30;
const COUNTED = `(watched_seconds IS NULL OR watched_seconds >= ${MIN_WATCHED_SECONDS})`;

interface SiloUserRow {
  id: string;
  username: string;
  role: string | null;
  enabled: number | null;
  is_owner: number;
  created_at: string | null;
  last_active_at: string | null;
}

interface PlayTotalsRow {
  user_id: string;
  plays: number;
  watched: number;
  plays30: number;
  direct: number;
  last_played_at: string;
  first_played_at: string;
}

export class UsersService {
  private cache: { at: number; users: UserSummary[] } | null = null;

  constructor(private readonly db: Database) {}

  list(): UserSummary[] {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.users;

    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const totals = this.db
      .prepare(
        `SELECT user_id, COUNT(*) AS plays, COALESCE(SUM(watched_seconds), 0) AS watched,
                SUM(started_at >= ?) AS plays30, SUM(play_method = 'direct') AS direct,
                MAX(ended_at) AS last_played_at, MIN(started_at) AS first_played_at
         FROM plays WHERE ${COUNTED} GROUP BY user_id`,
      )
      .all(monthAgo) as unknown as PlayTotalsRow[];

    const lastPlays = this.db
      .prepare(
        `SELECT user_id, username, title, series_title, media_type FROM (
           SELECT user_id, username, title, series_title, media_type,
                  ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ended_at DESC) AS n
           FROM plays WHERE ${COUNTED}
         ) WHERE n = 1`,
      )
      .all() as { user_id: string; username: string; title: string; series_title: string | null; media_type: string }[];

    const platforms = this.db
      .prepare(
        `SELECT user_id, device_platform AS platform, COUNT(*) AS plays FROM plays
         WHERE ${COUNTED} AND device_platform IS NOT NULL AND device_platform <> ''
         GROUP BY user_id, device_platform`,
      )
      .all() as { user_id: string; platform: string; plays: number }[];

    const siloUsers = this.db.prepare('SELECT * FROM silo_users').all() as unknown as SiloUserRow[];

    const totalsById = new Map(totals.map((t) => [t.user_id, t]));
    const lastById = new Map(lastPlays.map((l) => [l.user_id, l]));
    const topPlatformById = topPlatforms(platforms);
    const siloById = new Map(siloUsers.map((u) => [u.id, u]));
    const ids = new Set([...siloById.keys(), ...totalsById.keys()]);

    const users = [...ids].map((id) => summarize(id, siloById.get(id), totalsById.get(id), lastById.get(id), topPlatformById.get(id)));
    users.sort((a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? '') || a.name.localeCompare(b.name));

    this.cache = { at: Date.now(), users };
    return users;
  }

  get(id: string): UserDetail | null {
    const summary = this.list().find((u) => u.id === id);
    if (!summary) return null;

    const first = this.db
      .prepare(`SELECT MIN(started_at) AS first FROM plays WHERE user_id = ? AND ${COUNTED}`)
      .get(id) as { first: string | null };

    const profiles = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(profile_name, ''), 'Main') AS name, COUNT(*) AS plays, MAX(ended_at) AS lastPlayedAt
         FROM plays WHERE user_id = ? AND ${COUNTED} GROUP BY name ORDER BY plays DESC`,
      )
      .all(id) as UserDetail['profiles'];

    const rawDevices = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(client_name, ''), 'Unknown player') AS player, device_platform AS platform,
                COUNT(*) AS plays, MAX(ended_at) AS lastPlayedAt
         FROM plays WHERE user_id = ? AND ${COUNTED}
         GROUP BY player, device_platform ORDER BY lastPlayedAt DESC`,
      )
      .all(id) as UserDetail['devices'];

    // Merge players that differ only by encoding or platform spelling.
    const devices = new Map<string, UserDetail['devices'][number]>();
    for (const d of rawDevices) {
      const player = cleanClientName(d.player) ?? d.player;
      const key = `${player}|${d.platform ? platformKey(d.platform) : ''}`;
      const existing = devices.get(key);
      if (existing) {
        existing.plays += d.plays;
        if (d.lastPlayedAt > existing.lastPlayedAt) existing.lastPlayedAt = d.lastPlayedAt;
      } else {
        devices.set(key, { ...d, player });
      }
    }

    const addresses = this.db
      .prepare(
        `SELECT client_ip AS ip, COUNT(*) AS plays, MIN(started_at) AS firstSeenAt, MAX(ended_at) AS lastSeenAt
         FROM plays WHERE user_id = ? AND ${COUNTED} AND client_ip IS NOT NULL AND client_ip <> ''
         GROUP BY client_ip ORDER BY lastSeenAt DESC LIMIT 50`,
      )
      .all(id) as UserDetail['addresses'];

    return {
      ...summary,
      firstPlayedAt: first.first,
      profiles,
      devices: [...devices.values()],
      addresses,
    };
  }
}

function summarize(
  id: string,
  silo: SiloUserRow | undefined,
  totals: PlayTotalsRow | undefined,
  last: { username: string; title: string; series_title: string | null; media_type: string } | undefined,
  topPlatform: string | undefined,
): UserSummary {
  return {
    id,
    name: silo?.username || last?.username || `Deleted user ${id}`,
    role: silo?.role ?? null,
    enabled: silo?.enabled == null ? null : silo.enabled === 1,
    isOwner: silo?.is_owner === 1,
    inSilo: Boolean(silo),
    createdAt: silo?.created_at ?? null,
    lastActiveAt: silo?.last_active_at ?? null,
    lastPlayedAt: totals?.last_played_at ?? null,
    lastPlayed: last ? { title: last.title, seriesTitle: last.series_title, mediaType: last.media_type } : null,
    plays: totals?.plays ?? 0,
    plays30Days: totals?.plays30 ?? 0,
    watchedSeconds: Math.round(totals?.watched ?? 0),
    topPlatform: topPlatform ?? null,
    directPlayPercent: totals?.plays ? Math.round((totals.direct / totals.plays) * 1000) / 10 : null,
  };
}

/** Each user's most-used platform, treating "android-tv" and "Android TV" as one. */
function topPlatforms(rows: { user_id: string; platform: string; plays: number }[]): Map<string, string> {
  const perUser = new Map<string, Map<string, { name: string; plays: number }>>();
  for (const row of rows) {
    const key = platformKey(row.platform);
    let platforms = perUser.get(row.user_id);
    if (!platforms) perUser.set(row.user_id, (platforms = new Map()));
    const existing = platforms.get(key);
    if (existing) existing.plays += row.plays;
    else platforms.set(key, { name: row.platform, plays: row.plays });
  }
  const result = new Map<string, string>();
  for (const [userId, platforms] of perUser) {
    const top = [...platforms.values()].sort((a, b) => b.plays - a.plays)[0];
    if (top) result.set(userId, top.name);
  }
  return result;
}
