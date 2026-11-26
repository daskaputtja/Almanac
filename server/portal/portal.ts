import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { FLAG_GROUP, type Severity } from '../../shared/moderation.js';
import {
  PORTAL_EVENT_LABELS,
  type PortalApiSettings,
  type PortalCustomer,
  type PortalEventType,
  type PortalUsage,
} from '../../shared/portal.js';
import type { FlagAlertLevel } from '../../shared/reliability.js';
import type { ActivityMonitor } from '../activity/monitor.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import type { PlaybackHealth } from '../health/health.js';
import type { FlagEvent, ModerationService } from '../moderation/service.js';
import type { SuspensionService } from '../suspensions/suspensions.js';
import type { UsersService } from '../users/users.js';

const KEY = 'portalApi';
const DAY_MS = 86_400_000;
/** A play that timed out stops counting as playing this long before its recorded end. */
const STALE_MS = 10 * 60_000;
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
/** Notes from the portal are written as this author (never a real Almanac account). */
const PORTAL_AUTHOR = { id: -1, name: 'Billing portal', manageAllNotes: false };

interface Stored {
  keyHash: string | null;
  keyHint: string | null;
  createdBy: string | null;
  createdAt: string | null;
  flagLevel: FlagAlertLevel;
}

export class PortalApiError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

export interface PortalDeps {
  users: UsersService;
  moderation: ModerationService;
  health: PlaybackHealth;
  monitor: Pick<ActivityMonitor, 'current'>;
  suspensions: SuspensionService;
  /** Almanac's own address, for links back to a customer. */
  baseUrl: () => string | null;
}

/**
 * The API a billing portal calls with its own key: look customers up, read
 * their usage for billing, and tell Almanac what the portal did (written to
 * the customer's notes). New flags can also be sent to the portal.
 * The portal never gets IP addresses.
 */
export class PortalApi {
  private readonly settingsStore: SettingsStore;
  private lastUsedWrite = 0;

  constructor(
    private readonly db: Database,
    private readonly deps: PortalDeps,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.settingsStore = new SettingsStore(db);
  }

  // --- The key -----------------------------------------------------------------

  private stored(): Stored {
    return { keyHash: null, keyHint: null, createdBy: null, createdAt: null, flagLevel: 'off', ...(this.settingsStore.get<Stored>(KEY)?.value ?? {}) };
  }

  settings(): PortalApiSettings {
    const s = this.stored();
    return {
      keySet: Boolean(s.keyHash),
      keyHint: s.keyHint,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      lastUsedAt: this.settingsStore.get<string>(`${KEY}.lastUsedAt`)?.value ?? null,
      flagLevel: s.flagLevel,
    };
  }

  /** Make a new key (replacing any old one). It's returned once and only its hash is kept. */
  createKey(by: string): { key: string; settings: PortalApiSettings } {
    const key = `alm_${randomBytes(32).toString('base64url')}`;
    this.settingsStore.set(KEY, { ...this.stored(), keyHash: hash(key), keyHint: key.slice(-4), createdBy: by, createdAt: new Date().toISOString() }, by);
    this.settingsStore.delete(`${KEY}.lastUsedAt`);
    return { key, settings: this.settings() };
  }

  revokeKey(by: string): PortalApiSettings {
    this.settingsStore.set(KEY, { ...this.stored(), keyHash: null, keyHint: null, createdBy: null, createdAt: null }, by);
    return this.settings();
  }

  setFlagLevel(level: unknown, by: string): PortalApiSettings {
    if (!['off', 'high', 'medium', 'low'].includes(level as string)) throw new PortalApiError('Unknown flag level.');
    this.settingsStore.set(KEY, { ...this.stored(), flagLevel: level as FlagAlertLevel }, by);
    return this.settings();
  }

  /** Is this the portal's key? */
  verify(token: string | null | undefined): boolean {
    const stored = this.stored().keyHash;
    if (!token || !stored) return false;
    const a = Buffer.from(hash(token), 'hex');
    const b = Buffer.from(stored, 'hex');
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (ok && Date.now() - this.lastUsedWrite > 60_000) {
      this.lastUsedWrite = Date.now();
      this.settingsStore.set(`${KEY}.lastUsedAt`, new Date().toISOString(), null);
    }
    return ok;
  }

  // --- Customers -----------------------------------------------------------------

  /** Find a customer by Silo ID, username or email (not case-sensitive). */
  find(by: { id?: unknown; username?: unknown; email?: unknown }): string | null {
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const id = text(by.id);
    const username = text(by.username);
    const email = text(by.email);
    if (!id && !username && !email) throw new PortalApiError('Give the customer’s id, username or email.');
    const row = id
      ? (this.db.prepare('SELECT id FROM silo_users WHERE id = ?').get(id) as { id: string } | undefined)
      : username
        ? (this.db.prepare('SELECT id FROM silo_users WHERE username = ? COLLATE NOCASE').get(username) as { id: string } | undefined)
        : (this.db.prepare('SELECT id FROM silo_users WHERE email = ? COLLATE NOCASE').get(email) as { id: string } | undefined);
    return row?.id ?? null;
  }

  customer(id: string, now = Date.now()): PortalCustomer | null {
    const user = this.deps.users.get(id);
    if (!user || !user.inSilo) return null;
    const health = this.deps.health.forUser(id, now);
    const main = health ? [...health.user.players].sort((a, b) => b.plays - a.plays)[0] : undefined;
    const flags = this.deps.moderation.flags({ userId: id, status: 'all', includeAdminDetails: false }).flags;
    const pending = this.deps.suspensions.list({ userId: id, status: 'pending' }).requests[0];
    const base = this.deps.baseUrl();
    return {
      id,
      username: user.name,
      email: user.email,
      enabled: user.enabled,
      createdAt: user.createdAt,
      lastActiveAt: user.lastActiveAt,
      lastPlayedAt: user.lastPlayedAt,
      watchingNow: this.deps.monitor.current().streams.filter((s) => s.user.id === id).length,
      usage: this.usage(id, 30, now),
      mainDevice: main ? (main.device?.kind === 'computer' ? 'Computer' : (main.device?.name ?? main.platform ?? null)) : null,
      playback: !health || !health.enoughPlays ? { status: 'unknown', issues: [] } : health.user.issues.length ? { status: 'struggling', issues: health.user.issues.map((i) => i.headline) } : { status: 'fine', issues: [] },
      flags: flags.map((f) => ({
        kind: f.kind,
        group: f.group,
        severity: f.severity,
        headline: f.headline,
        since: f.firstSeenAt,
        reviewed: f.status === 'reviewed',
      })),
      exceptions: this.deps.moderation.exceptions(id, now).map((e) => ({ group: e.group, until: e.expiresAt, reason: e.reason })),
      pendingSuspension: pending ? { action: pending.action, requestedAt: pending.requestedAt } : null,
      almanacUrl: base ? `${base}/users/${encodeURIComponent(id)}` : null,
    };
  }

  /** Usage for billing over the last `days` days. */
  usage(id: string, days: number, now = Date.now()): PortalUsage {
    return this.usageFor([id], days, now).get(id)!;
  }

  /** Usage for every customer in Silo, for billing runs. */
  allUsage(days: number, now = Date.now()): { id: string; username: string; email: string | null; enabled: boolean | null; usage: PortalUsage }[] {
    const users = this.db.prepare('SELECT id, username, email, enabled FROM silo_users ORDER BY username COLLATE NOCASE').all() as {
      id: string;
      username: string;
      email: string | null;
      enabled: number | null;
    }[];
    const usage = this.usageFor(
      users.map((u) => u.id),
      days,
      now,
    );
    return users.map((u) => ({ id: u.id, username: u.username, email: u.email, enabled: u.enabled == null ? null : u.enabled === 1, usage: usage.get(u.id)! }));
  }

  private usageFor(ids: string[], days: number, now: number): Map<string, PortalUsage> {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new PortalApiError('days must be a whole number from 1 to 365.');
    const since = new Date(now - days * DAY_MS).toISOString();
    const wanted = new Set(ids);
    const out = new Map<string, PortalUsage>();
    const empty = (): PortalUsage => ({
      days,
      plays: 0,
      hoursWatched: 0,
      activeDays: 0,
      peakStreams: 0,
      peakStreamsAt: null,
      devicesUsed: 0,
      devicesSignedIn: 0,
      downloads: 0,
      downloadGb: 0,
      vpnShare: null,
    });
    for (const id of ids) out.set(id, empty());

    const plays = this.db
      .prepare(
        `SELECT p.user_id, p.started_at, p.ended_at, p.watched_seconds, p.end_reason, p.device_id, p.client_name, p.client_ip, l.network_kind
         FROM plays p LEFT JOIN ip_locations l ON l.ip = p.client_ip
         WHERE p.started_at >= ? ${ids.length === 1 ? 'AND p.user_id = ?' : ''} ORDER BY p.started_at`,
      )
      .all(...(ids.length === 1 ? [since, ids[0]!] : [since])) as {
      user_id: string;
      started_at: string;
      ended_at: string;
      watched_seconds: number | null;
      end_reason: string | null;
      device_id: string | null;
      client_name: string | null;
      client_ip: string | null;
      network_kind: string | null;
    }[];
    const byUser = new Map<string, typeof plays>();
    for (const p of plays) {
      if (!wanted.has(p.user_id)) continue;
      const list = byUser.get(p.user_id) ?? [];
      list.push(p);
      byUser.set(p.user_id, list);
    }
    for (const [id, list] of byUser) {
      const u = out.get(id)!;
      u.plays = list.length;
      u.hoursWatched = Math.round(list.reduce((n, p) => n + (p.watched_seconds ?? 0), 0) / 360) / 10;
      u.activeDays = new Set(list.map((p) => p.started_at.slice(0, 10))).size;
      const device = (p: (typeof list)[number]) => p.device_id ?? `${p.client_name ?? '?'}|${p.client_ip ?? '?'}`;
      u.devicesUsed = new Set(list.map(device)).size;
      // Streams at once: a device can only play one thing, and a timed-out stream had already stopped.
      const spans = list.map((p) => {
        const start = Date.parse(p.started_at);
        const end = Date.parse(p.ended_at);
        return { start, end: p.end_reason === 'expired' ? Math.max(start, end - STALE_MS) : end, device: device(p) };
      });
      for (const s of spans) {
        const devices = new Set(spans.filter((o) => o.start <= s.start && o.end > s.start).map((o) => o.device));
        if (devices.size > u.peakStreams) {
          u.peakStreams = devices.size;
          u.peakStreamsAt = new Date(s.start).toISOString();
        }
      }
      const known = list.filter((p) => p.network_kind === 'vpn' || p.network_kind === 'isp');
      u.vpnShare = known.length ? Math.round((known.filter((p) => p.network_kind === 'vpn').length / known.length) * 100) / 100 : null;
    }

    const downloads = this.db
      .prepare(`SELECT user_id, COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS bytes FROM downloads WHERE created_at >= ? AND COALESCE(status, '') <> 'failed' GROUP BY user_id`)
      .all(since) as { user_id: string; n: number; bytes: number }[];
    for (const d of downloads) {
      const u = out.get(d.user_id);
      if (!u) continue;
      u.downloads = d.n;
      u.downloadGb = Math.round(d.bytes / 1e8) / 10;
    }
    const devices = this.db.prepare('SELECT user_id, COUNT(*) AS n FROM registered_devices WHERE last_used_at >= ? GROUP BY user_id').all(since) as { user_id: string; n: number }[];
    for (const d of devices) {
      const u = out.get(d.user_id);
      if (u) u.devicesSignedIn = d.n;
    }
    return out;
  }

  // --- From the portal -------------------------------------------------------------

  /** The portal says what it did (suspended, reactivated, plan changed…). Written to the customer's notes. */
  recordEvent(input: { customer?: unknown; type?: unknown; detail?: unknown; plan?: unknown }): { userId: string; note: string } {
    const customer = (input.customer && typeof input.customer === 'object' ? input.customer : {}) as Record<string, unknown>;
    const userId = this.find(customer);
    if (!userId) throw new PortalApiError('No customer with that id, username or email in Silo.', 404);
    const type = input.type as PortalEventType;
    if (!(type in PORTAL_EVENT_LABELS)) throw new PortalApiError(`type must be one of: ${Object.keys(PORTAL_EVENT_LABELS).join(', ')}.`);
    const detail = typeof input.detail === 'string' ? input.detail.trim().slice(0, 1000) : '';
    const plan = typeof input.plan === 'string' ? input.plan.trim().slice(0, 100) : '';
    if (type === 'note' && !detail) throw new PortalApiError('A note needs some detail.');
    const parts = [PORTAL_EVENT_LABELS[type], plan && type === 'plan_changed' ? `to ${plan}` : plan ? `(plan: ${plan})` : ''].filter(Boolean).join(' ');
    const note = type === 'note' ? detail : `${parts}${detail ? `: ${detail}` : '.'}`;
    this.deps.moderation.addNote(userId, PORTAL_AUTHOR, note);
    return { userId, note };
  }

  // --- To the portal -------------------------------------------------------------

  /** Send new, worse or reopened flags at the chosen level to the portal (signed like suspension requests). */
  async flagEvents(events: FlagEvent[]): Promise<number> {
    const level = this.stored().flagLevel;
    if (level === 'off' || !this.deps.suspensions.portal().url) return 0;
    const wanted = events.filter((e) => SEVERITY_RANK[e.severity] >= SEVERITY_RANK[level as Severity]);
    for (const e of wanted) {
      try {
        await this.deps.suspensions.sendEvent({
          event: 'flag',
          customer: { id: e.userId, username: e.username, email: e.email },
          flag: {
            reason: e.reason,
            kind: e.kind,
            group: FLAG_GROUP[e.kind],
            severity: e.severity,
            headline: e.headline,
            details: e.details.map(plainTimes),
          },
          almanac_url: this.deps.baseUrl() ? `${this.deps.baseUrl()}/users/${encodeURIComponent(e.userId)}` : null,
        });
      } catch (err) {
        this.log(`Flag not sent to the billing portal: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return wanted.length;
  }
}

function hash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Flag text marks times as {{time:ISO}}; the portal gets the ISO time itself. */
function plainTimes(text: string): string {
  return text.replace(/\{\{time:([^}]+)\}\}/g, (_, iso: string) => iso);
}
