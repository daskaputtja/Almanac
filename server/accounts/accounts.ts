import type { DownloadEntry, DownloadsResponse, RegisteredDevice, UserDownloads } from '../../shared/accounts.js';
import { type Database, transaction } from '../db/database.js';
import type { AccountSource } from '../silo/client.js';
import type { SiloDevice, SiloDownload } from '../silo/types.js';

const SYNC_EVERY_MS = 10 * 60_000;
/** Downloads Silo no longer lists are kept this long, for history and the downloading check. */
const KEEP_DOWNLOADS_MS = 400 * 86_400_000;
const SYNCED_KEY = 'accounts_synced_at';

interface DownloadRow {
  id: string;
  user_id: string;
  username: string | null;
  device_name: string | null;
  title: string | null;
  media_type: string | null;
  season_number: number | null;
  episode_number: number | null;
  episode_title: string | null;
  status: string | null;
  quality: string | null;
  file_size: number | null;
  client_ip: string | null;
  created_at: string;
  present: number;
}

/**
 * Keeps Almanac's copy of offline downloads and registered devices. Silo
 * only lists current downloads, so Almanac keeps its own record: a download
 * someone deletes still counts towards the downloading check.
 */
export class AccountsService {
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly source: AccountSource,
    private readonly log: (message: string) => void = console.log,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.sync();
      this.timer = setTimeout(tick, SYNC_EVERY_MS);
    };
    this.timer = setTimeout(tick, 5_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async sync(now = Date.now()): Promise<void> {
    const problems: string[] = [];
    try {
      this.storeDownloads(await this.source.listDownloads(), now);
    } catch (err) {
      problems.push(`downloads: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.storeDevices(await this.source.listDevices(), now);
    } catch (err) {
      problems.push(`devices: ${err instanceof Error ? err.message : String(err)}`);
    }
    const message = problems.length ? problems.join('; ') : null;
    if (message && message !== this.lastError) this.log(`Couldn’t copy ${message}`);
    this.lastError = message;
    if (!message) this.db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(SYNCED_KEY, new Date(now).toISOString());
  }

  storeDownloads(downloads: SiloDownload[], now = Date.now()): void {
    const at = new Date(now).toISOString();
    transaction(this.db, () => {
      const upsert = this.db.prepare(
        `INSERT INTO downloads (id, user_id, username, device_name, content_id, title, media_type, season_number, episode_number,
           episode_title, status, quality, file_size, client_ip, created_at, completed_at, present, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (id) DO UPDATE SET username = excluded.username, device_name = excluded.device_name,
           title = COALESCE(NULLIF(excluded.title, ''), downloads.title), status = excluded.status, quality = excluded.quality,
           file_size = COALESCE(excluded.file_size, downloads.file_size), completed_at = excluded.completed_at,
           client_ip = COALESCE(downloads.client_ip, excluded.client_ip), present = 1, synced_at = excluded.synced_at`,
      );
      for (const d of downloads) {
        upsert.run(
          d.id,
          String(d.user_id),
          d.username ?? null,
          d.device_name ?? null,
          d.content_id ?? null,
          d.title || null,
          d.media_type ?? null,
          d.episode?.season_number ?? null,
          d.episode?.episode_number ?? null,
          d.episode?.title ?? null,
          d.status ?? null,
          d.quality ?? null,
          d.file_size ?? null,
          d.created_client_ip ?? null,
          d.created_at,
          d.completed_at ?? null,
          at,
        );
      }
      this.db.prepare('UPDATE downloads SET present = 0 WHERE synced_at < ?').run(at);
      this.db.prepare('DELETE FROM downloads WHERE present = 0 AND created_at < ?').run(new Date(now - KEEP_DOWNLOADS_MS).toISOString());
    });
  }

  storeDevices(devices: SiloDevice[], now = Date.now()): void {
    const at = new Date(now).toISOString();
    transaction(this.db, () => {
      const upsert = this.db.prepare(
        `INSERT INTO registered_devices (user_id, device_id, device_name, platform, profiles, last_used_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, device_id) DO UPDATE SET device_name = excluded.device_name, platform = excluded.platform,
           profiles = excluded.profiles, last_used_at = excluded.last_used_at, synced_at = excluded.synced_at`,
      );
      for (const d of devices) {
        const profiles = (d.profiles ?? []).map((p) => p.profile_name).filter((n): n is string => Boolean(n));
        upsert.run(String(d.user_id), d.device_id, d.device_name ?? null, d.device_platform ?? null, JSON.stringify(profiles), d.last_updated ?? null, at);
      }
      // A device removed from an account in Silo is gone for good.
      this.db.prepare('DELETE FROM registered_devices WHERE synced_at < ?').run(at);
    });
  }

  // --- Reading -----------------------------------------------------------------

  overview(includeIps: boolean, now = Date.now()): DownloadsResponse {
    const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
    const sum = (sql: string, ...params: string[]) =>
      this.db.prepare(sql).get(...params) as { n: number; bytes: number | null };
    const onDevices = sum(`SELECT COUNT(*) AS n, SUM(file_size) AS bytes FROM downloads WHERE present = 1 AND ${KEPT}`);
    const week = sum('SELECT COUNT(*) AS n, SUM(file_size) AS bytes FROM downloads WHERE created_at >= ?', days(7));
    const month = sum('SELECT COUNT(*) AS n, SUM(file_size) AS bytes FROM downloads WHERE created_at >= ?', days(30));
    const accounts = this.db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM downloads WHERE present = 1 AND ${KEPT}`).get() as { n: number };
    const since = this.db.prepare('SELECT MIN(created_at) AS at FROM downloads').get() as { at: string | null };

    const top = this.db
      .prepare(
        `SELECT d.user_id, COALESCE(u.username, MAX(d.username), d.user_id) AS username, u.email, COUNT(*) AS downloads,
                COALESCE(SUM(d.file_size), 0) AS bytes, MAX(d.created_at) AS last_at
         FROM downloads d LEFT JOIN silo_users u ON u.id = d.user_id
         WHERE d.created_at >= ? GROUP BY d.user_id ORDER BY downloads DESC, bytes DESC LIMIT 15`,
      )
      .all(days(30)) as { user_id: string; username: string; email: string | null; downloads: number; bytes: number; last_at: string }[];

    const recent = this.db.prepare('SELECT * FROM downloads ORDER BY created_at DESC LIMIT 100').all() as unknown as DownloadRow[];
    const synced = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(SYNCED_KEY) as { value: string } | undefined;

    return {
      since: since.at,
      totals: {
        onDevices: onDevices.n,
        onDevicesBytes: onDevices.bytes ?? 0,
        accountsWithDownloads: accounts.n,
        last7Days: week.n,
        last7DaysBytes: week.bytes ?? 0,
        last30Days: month.n,
        last30DaysBytes: month.bytes ?? 0,
      },
      topUsers: top.map((t) => ({ userId: t.user_id, username: t.username, email: t.email, downloads: t.downloads, bytes: t.bytes, lastAt: t.last_at })),
      recent: recent.map((r) => entry(r, this.usernames(), includeIps)),
      syncedAt: synced?.value ?? null,
    };
  }

  forUser(userId: string, includeIps: boolean, now = Date.now()): UserDownloads {
    const since = new Date(now - 30 * 86_400_000).toISOString();
    const month = this.db
      .prepare('SELECT COUNT(*) AS n, SUM(file_size) AS bytes FROM downloads WHERE user_id = ? AND created_at >= ?')
      .get(userId, since) as { n: number; bytes: number | null };
    const all = this.db
      .prepare(`SELECT COUNT(*) AS n, SUM(file_size) AS bytes, SUM(present = 1 AND ${KEPT}) AS on_devices FROM downloads WHERE user_id = ?`)
      .get(userId) as { n: number; bytes: number | null; on_devices: number | null };
    const recent = this.db.prepare('SELECT * FROM downloads WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId) as unknown as DownloadRow[];
    return {
      last30Days: month.n,
      last30DaysBytes: month.bytes ?? 0,
      total: all.n,
      totalBytes: all.bytes ?? 0,
      onDevices: all.on_devices ?? 0,
      recent: recent.map((r) => entry(r, this.usernames(), includeIps)),
    };
  }

  devicesForUser(userId: string): RegisteredDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM registered_devices WHERE user_id = ? ORDER BY last_used_at DESC')
      .all(userId) as { device_id: string; device_name: string | null; platform: string | null; profiles: string | null; last_used_at: string | null }[];
    return rows.map((r) => ({
      deviceId: r.device_id,
      name: r.device_name || 'Unnamed device',
      platform: r.platform,
      profiles: parseList(r.profiles),
      lastUsedAt: r.last_used_at,
    }));
  }

  private usernameCache: { at: number; map: Map<string, string> } | null = null;
  private usernames(): Map<string, string> {
    if (this.usernameCache && Date.now() - this.usernameCache.at < 60_000) return this.usernameCache.map;
    const map = new Map((this.db.prepare('SELECT id, username FROM silo_users').all() as { id: string; username: string }[]).map((r) => [r.id, r.username]));
    this.usernameCache = { at: Date.now(), map };
    return map;
  }
}

/** Downloads that are (or will be) on a device: not revoked or failed. */
const KEPT = "COALESCE(status, '') NOT IN ('revoked', 'failed')";

function entry(r: DownloadRow, usernames: Map<string, string>, includeIp: boolean): DownloadEntry {
  const pad = (n: number) => String(n).padStart(2, '0');
  const code = r.season_number != null && r.episode_number != null ? `S${pad(r.season_number)}E${pad(r.episode_number)}` : null;
  return {
    id: r.id,
    userId: r.user_id,
    username: usernames.get(r.user_id) ?? r.username ?? r.user_id,
    title: r.title || 'Removed from Silo',
    episode: code ? [code, r.episode_title].filter(Boolean).join(' · ') : null,
    mediaType: r.media_type ?? '',
    deviceName: r.device_name,
    status: r.status ?? 'unknown',
    quality: r.quality,
    sizeBytes: r.file_size,
    createdAt: r.created_at,
    present: r.present === 1,
    ip: includeIp ? r.client_ip : null,
  };
}

function parseList(json: string | null): string[] {
  try {
    const value = JSON.parse(json ?? '[]') as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}
