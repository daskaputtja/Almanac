import { FLAG_GROUP, GROUP_LABELS, type Severity } from '../../shared/moderation.js';
import { can, type Permission, type Role } from '../../shared/permissions.js';
import { DEFAULT_PUSH_PREFERENCES, type PushPreferences } from '../../shared/app.js';
import type { Database } from '../db/database.js';
import type { FlagEvent } from '../moderation/service.js';

/** Expo's push service: one address for iPhone and Android, no Apple or Google keys on the server. */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[\w-]{10,200}\]$/;
const BATCH = 100;
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
const SEVERITY_LABEL: Record<Severity, string> = { low: 'Minor', medium: 'Worth a look', high: 'Serious' };

export class PushError extends Error {}

export interface PushMessage {
  title: string;
  body: string;
  /** Where the app should open when the notification is tapped, e.g. "/users/42". */
  path?: string;
}

interface DeviceRow {
  session_id: string;
  user_id: number;
  username: string;
  role: Role;
  push_token: string;
  preferences: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Push notifications to the phone app, sent through Expo. */
export class PushService {
  constructor(
    private readonly db: Database,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: (message: string) => void = console.log,
    /** Only needed if "enhanced push security" is turned on for the app in Expo. */
    private readonly accessToken: string | null = null,
  ) {}

  // --- Phones ------------------------------------------------------------------

  register(sessionId: string, userId: number, input: { pushToken?: unknown; platform?: unknown; deviceName?: unknown }): PushPreferences {
    const token = typeof input.pushToken === 'string' ? input.pushToken.trim() : '';
    if (!EXPO_TOKEN.test(token)) throw new PushError('That isn’t an Expo push token.');
    const platform = input.platform === 'ios' || input.platform === 'android' ? input.platform : null;
    const name = typeof input.deviceName === 'string' ? input.deviceName.trim().slice(0, 80) || null : null;
    const existing = this.row(sessionId);
    // One phone, one registration: if this phone was signed in before, drop the old one.
    this.db.prepare('DELETE FROM push_devices WHERE push_token = ? AND session_id <> ?').run(token, sessionId);
    this.db
      .prepare(
        `INSERT INTO push_devices (session_id, user_id, push_token, platform, device_name, preferences, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET push_token = excluded.push_token, platform = excluded.platform,
           device_name = excluded.device_name, last_error = NULL`,
      )
      .run(sessionId, userId, token, platform, name, existing?.preferences ?? JSON.stringify(DEFAULT_PUSH_PREFERENCES), new Date().toISOString());
    return this.preferences(sessionId)!;
  }

  unregister(sessionId: string): void {
    this.db.prepare('DELETE FROM push_devices WHERE session_id = ?').run(sessionId);
  }

  preferences(sessionId: string): PushPreferences | null {
    const row = this.row(sessionId);
    return row ? parsePreferences(row.preferences) : null;
  }

  setPreferences(sessionId: string, input: Partial<PushPreferences>): PushPreferences {
    const current = this.preferences(sessionId);
    if (!current) throw new PushError('Turn on notifications in the app first.');
    const next: PushPreferences = {
      flags: ['off', 'high', 'medium', 'low'].includes(input.flags as string) ? (input.flags as PushPreferences['flags']) : current.flags,
      suspensions: typeof input.suspensions === 'boolean' ? input.suspensions : current.suspensions,
      serverAlerts: typeof input.serverAlerts === 'boolean' ? input.serverAlerts : current.serverAlerts,
      details: typeof input.details === 'boolean' ? input.details : current.details,
    };
    this.db.prepare('UPDATE push_devices SET preferences = ? WHERE session_id = ?').run(JSON.stringify(next), sessionId);
    return next;
  }

  async test(sessionId: string): Promise<void> {
    const device = this.devices().find((d) => d.session_id === sessionId);
    if (!device) throw new PushError('Turn on notifications in the app first.');
    await this.deliver([{ device, message: { title: 'Almanac', body: 'Notifications are working.' } }]);
  }

  // --- What gets sent ------------------------------------------------------------

  /** New, worse or reopened account flags, to people who can moderate and want that severity. */
  async flagEvents(events: FlagEvent[]): Promise<void> {
    const out: { device: DeviceRow; message: PushMessage }[] = [];
    for (const device of this.devices('moderate')) {
      const prefs = parsePreferences(device.preferences);
      if (prefs.flags === 'off') continue;
      const wanted = events.filter((e) => SEVERITY_RANK[e.severity] >= SEVERITY_RANK[prefs.flags as Severity]);
      if (!wanted.length) continue;
      if (wanted.length > 3) {
        out.push({ device, message: { title: `${wanted.length} new account flags`, body: 'Open the Moderation page to review them.', path: '/moderation' } });
        continue;
      }
      for (const e of wanted) {
        out.push({
          device,
          message: prefs.details
            ? { title: `${SEVERITY_LABEL[e.severity]} · ${GROUP_LABELS[FLAG_GROUP[e.kind]].title}`, body: `${e.username}: ${e.headline}`, path: `/users/${encodeURIComponent(e.userId)}` }
            : { title: 'New account flag', body: `${SEVERITY_LABEL[e.severity]}. Open Almanac to see it.`, path: '/moderation' },
        });
      }
    }
    await this.deliver(out);
  }

  /** A mod asked for a suspension: tell the people who can approve it. */
  async suspensionRequested(request: { userId: string; username: string; action: string; requestedBy: string }): Promise<void> {
    const out = this.devices('reviewSuspension')
      .filter((d) => parsePreferences(d.preferences).suspensions && d.username !== request.requestedBy)
      .map((device) => ({
        device,
        message: parsePreferences(device.preferences).details
          ? { title: 'Suspension request', body: `${request.requestedBy} asks to ${request.action} ${request.username}.`, path: '/moderation' }
          : { title: 'Suspension request', body: 'A request is waiting for an admin.', path: '/moderation' },
      }));
    await this.deliver(out);
  }

  /** A request was approved, rejected or failed: tell whoever asked for it. */
  async suspensionDecided(request: { userId: string; username: string; action: string; requestedBy: string; status: string; reviewedBy: string | null }): Promise<void> {
    if (!request.reviewedBy || request.reviewedBy === request.requestedBy) return;
    const outcome = request.status === 'done' ? 'approved' : request.status === 'rejected' ? 'rejected' : 'couldn’t be carried out';
    const out = this.devices('requestSuspension')
      .filter((d) => d.username === request.requestedBy && parsePreferences(d.preferences).suspensions)
      .map((device) => ({
        device,
        message: parsePreferences(device.preferences).details
          ? { title: `Request ${outcome}`, body: `Your request to ${request.action} ${request.username} was ${outcome} by ${request.reviewedBy}.`, path: `/users/${encodeURIComponent(request.userId)}` }
          : { title: `Request ${outcome}`, body: 'Open Almanac to see it.', path: '/moderation' },
      }));
    await this.deliver(out);
  }

  /** Server trouble: streams dropping, a server down or back up. */
  async serverAlert(message: PushMessage): Promise<void> {
    const out = this.devices('moderate')
      .filter((d) => parsePreferences(d.preferences).serverAlerts)
      .map((device) => ({ device, message }));
    await this.deliver(out);
  }

  // --- Internals -------------------------------------------------------------------

  /** Registered phones whose app sign-in is still valid, optionally only for people with a permission. */
  private devices(permission?: Permission): DeviceRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.session_id, d.user_id, u.username, u.role, d.push_token, d.preferences
         FROM push_devices d
         JOIN auth_sessions s ON s.public_id = d.session_id AND s.stage = 'full' AND s.expires_at > ?
         JOIN auth_users u ON u.id = d.user_id`,
      )
      .all(new Date().toISOString()) as unknown as DeviceRow[];
    return permission ? rows.filter((r) => can(r.role, permission)) : rows;
  }

  private row(sessionId: string): { preferences: string } | undefined {
    return this.db.prepare('SELECT preferences FROM push_devices WHERE session_id = ?').get(sessionId) as { preferences: string } | undefined;
  }

  private async deliver(items: { device: DeviceRow; message: PushMessage }[]): Promise<void> {
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      let tickets: { status?: string; message?: string; details?: { error?: string } }[] = [];
      try {
        const res = await this.fetchImpl(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify(
            batch.map(({ device, message }) => ({
              to: device.push_token,
              title: message.title,
              body: message.body,
              data: message.path ? { path: message.path } : {},
              sound: 'default',
              priority: 'high',
            })),
          ),
          signal: AbortSignal.timeout(15_000),
        });
        tickets = ((await res.json().catch(() => ({}))) as { data?: typeof tickets }).data ?? [];
        if (!res.ok) throw new Error(`Expo answered ${res.status}`);
      } catch (err) {
        this.log(`Push notifications not sent: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const now = new Date().toISOString();
      batch.forEach(({ device }, j) => {
        const ticket = tickets[j];
        if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          // The app was uninstalled or notifications were turned off on the phone.
          this.unregister(device.session_id);
        } else if (ticket?.status === 'error') {
          this.db.prepare('UPDATE push_devices SET last_error = ? WHERE session_id = ?').run(ticket.message ?? 'Push failed', device.session_id);
        } else {
          this.db.prepare('UPDATE push_devices SET last_sent_at = ?, last_error = NULL WHERE session_id = ?').run(now, device.session_id);
        }
      });
    }
  }
}

function parsePreferences(json: string): PushPreferences {
  try {
    return { ...DEFAULT_PUSH_PREFERENCES, ...(JSON.parse(json) as Partial<PushPreferences>) };
  } catch {
    return DEFAULT_PUSH_PREFERENCES;
  }
}
