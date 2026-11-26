import {
  FLAG_GROUP,
  type FlagKind,
  type FlagPreview,
  type FlagThresholds,
  type PreviewCounts,
  type ThresholdsResponse,
  DEFAULT_THRESHOLDS,
  withDefaults,
  type FlagsResponse,
  type ModerationFlag,
  type Severity,
  type TagsResponse,
  type UserNote,
  type ExceptionLevel,
  type FlagException,
  type FlagGroup,
  GROUP_LABELS,
  LEVEL_LABELS,
} from '../../shared/moderation.js';
import { type Database, transaction } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import type { CaseFile } from '../../shared/moderation.js';
import type { SuspensionService } from '../suspensions/suspensions.js';
import { buildCaseFile } from './casefile.js';
import { type AccountExtras, type DetectedFlag, type LiveStreamForDetection, type Locate, type PlayForDetection, detectFlags } from './detect.js';

export const WINDOW_DAYS = 7;
/** Signed-in devices count as in use if Silo saw them this recently. */
export const DEVICE_WINDOW_DAYS = 30;
/** A reviewed flag reopens when its measure grows by this much. */
const REOPEN_GROWTH = 1.25;
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
const MAX_NOTE_LENGTH = 4000;
const MAX_TAG_LENGTH = 32;
const MAX_TAGS_PER_USER = 12;

interface FlagRow {
  user_id: string;
  kind: string;
  severity: Severity;
  value: number;
  headline: string;
  details: string;
  admin_details: string;
  first_seen: string;
  last_seen: string;
  active: number;
  status: 'open' | 'reviewed';
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  reviewed_value: number | null;
}

export class ModerationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

export interface Actor {
  id: number;
  name: string;
  /** May edit and delete anyone's notes. */
  manageAllNotes: boolean;
}

const THRESHOLDS_KEY = 'flagThresholds';

/** A flag worth telling staff about. Details are the mod-safe ones (no addresses). */
export interface FlagEvent {
  reason: 'new' | 'worse' | 'reopened';
  userId: string;
  username: string;
  email: string | null;
  kind: FlagKind;
  severity: Severity;
  headline: string;
  details: string[];
}

export class ModerationService {
  private checkedAt: string | null = null;
  /** What was playing at the last check, reused for previews and re-checks after a settings change. */
  private lastLive = new Map<string, LiveStreamForDetection[]>();
  private readonly settings: SettingsStore;
  private listener: ((events: FlagEvent[]) => void) | null = null;

  constructor(private readonly db: Database) {
    this.settings = new SettingsStore(db);
  }

  // ----- Thresholds -----

  thresholds(): FlagThresholds {
    return withDefaults(this.settings.get<FlagThresholds>(THRESHOLDS_KEY)?.value);
  }

  thresholdsResponse(): ThresholdsResponse {
    const stored = this.settings.get<FlagThresholds>(THRESHOLDS_KEY);
    return {
      thresholds: withDefaults(stored?.value),
      defaults: DEFAULT_THRESHOLDS,
      updatedBy: stored?.updatedBy ?? null,
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  /** Be told when flags appear, get worse or reopen (for staff alerts). */
  onFlagEvents(listener: (events: FlagEvent[]) => void): void {
    this.listener = listener;
  }

  /** Save new thresholds (already validated) and re-check every account with them. */
  setThresholds(thresholds: FlagThresholds, by: string): void {
    this.settings.set(THRESHOLDS_KEY, thresholds, by);
    // Flags that appear because an admin changed the levels aren't news.
    this.refresh(this.lastLive, Date.now(), { quiet: true });
  }

  /** How many accounts the current and the proposed thresholds flag, without saving anything. */
  preview(proposed: FlagThresholds, now = Date.now()): FlagPreview {
    const count = (thresholds: FlagThresholds): PreviewCounts => {
      const detected = this.detectAll(this.lastLive, now, thresholds);
      const empty = () => ({ low: 0, medium: 0, high: 0 });
      const byKind = Object.fromEntries(Object.keys(FLAG_GROUP).map((k) => [k, empty()])) as PreviewCounts['byKind'];
      for (const flags of detected.values()) for (const f of flags) byKind[f.kind][f.severity]++;
      return { accounts: detected.size, byKind };
    };
    return { current: count(this.thresholds()), proposed: count(proposed) };
  }

  /**
   * Run every check over the last week of plays (and what's playing now),
   * then update the stored flags. Takes well under a second on a busy server.
   */
  refresh(liveByUser: Map<string, LiveStreamForDetection[]> = new Map(), now = Date.now(), options: { quiet?: boolean } = {}): void {
    this.lastLive = liveByUser;
    const detected = this.detectAll(liveByUser, now, this.thresholds());
    const events = this.store(detected, now);
    if (events.length && this.listener && !options.quiet) {
      try {
        this.listener(events);
      } catch {
        // Alerts must never stop the checks.
      }
    }
  }

  private detectAll(liveByUser: Map<string, LiveStreamForDetection[]>, now: number, thresholds: FlagThresholds): Map<string, DetectedFlag[]> {
    const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT user_id, started_at, ended_at, media_type, title, series_title, watched_seconds, paused_seconds,
                completed, duration_seconds, client_ip, device_id, client_name, end_reason
         FROM plays WHERE started_at >= ?`,
      )
      .all(since) as {
      user_id: string;
      started_at: string;
      ended_at: string;
      media_type: string;
      title: string;
      series_title: string | null;
      watched_seconds: number | null;
      paused_seconds: number | null;
      completed: number;
      duration_seconds: number | null;
      client_ip: string | null;
      device_id: string | null;
      client_name: string | null;
      end_reason: string | null;
    }[];

    const byUser = new Map<string, PlayForDetection[]>();
    for (const r of rows) {
      let list = byUser.get(r.user_id);
      if (!list) byUser.set(r.user_id, (list = []));
      list.push({
        startedAt: r.started_at,
        endedAt: r.ended_at,
        mediaType: r.media_type,
        title: r.title,
        seriesTitle: r.series_title,
        watchedSeconds: r.watched_seconds,
        pausedSeconds: r.paused_seconds,
        completed: r.completed === 1,
        durationSeconds: r.duration_seconds,
        ip: r.client_ip,
        deviceId: r.device_id,
        player: r.client_name,
        endReason: r.end_reason,
      });
    }

    // Offline downloads and signed-in devices, copied from Silo by the accounts sync.
    const extras = new Map<string, AccountExtras>();
    const extrasFor = (userId: string) => {
      let e = extras.get(userId);
      if (!e) extras.set(userId, (e = { downloads: [], activeDevices: [] }));
      return e;
    };
    const downloads = this.db
      .prepare("SELECT user_id, created_at, file_size, title, device_name FROM downloads WHERE created_at >= ? AND COALESCE(status, '') <> 'failed'")
      .all(since) as { user_id: string; created_at: string; file_size: number | null; title: string | null; device_name: string | null }[];
    for (const d of downloads) {
      extrasFor(d.user_id).downloads.push({ createdAt: d.created_at, sizeBytes: d.file_size, title: d.title || 'Unknown title', deviceName: d.device_name });
    }
    const deviceSince = new Date(now - DEVICE_WINDOW_DAYS * 86_400_000).toISOString();
    const devices = this.db
      .prepare('SELECT user_id, device_name, platform FROM registered_devices WHERE last_used_at >= ?')
      .all(deviceSince) as { user_id: string; device_name: string | null; platform: string | null }[];
    for (const d of devices) extrasFor(d.user_id).activeDevices.push({ name: d.device_name ?? 'Unnamed device', platform: d.platform });

    // Where addresses are, from the viewer map's local lookups (empty if that's turned off).
    const places = new Map(
      (
        this.db
          .prepare(
            'SELECT ip, country_code, city, latitude, longitude, operator, network_kind FROM ip_locations WHERE country_code IS NOT NULL AND ip IN (SELECT DISTINCT client_ip FROM plays WHERE started_at >= ?)',
          )
          .all(since) as { ip: string; country_code: string; city: string | null; latitude: number | null; longitude: number | null; operator: string | null; network_kind: string | null }[]
      ).map((r) => [r.ip, { country: r.country_code, city: r.city, lat: r.latitude, lon: r.longitude, vpn: r.network_kind === 'vpn', operator: r.operator }]),
    );
    const locate: Locate = (ip) => places.get(ip) ?? null;

    // Accounts allowed to do some of this: their flags up to the allowed level don't count.
    const allowed = new Map<string, ExceptionLevel>();
    for (const e of this.activeExceptionRows(now)) allowed.set(`${e.user_id}:${e.flag_group}`, e.up_to);

    const detected = new Map<string, DetectedFlag[]>();
    for (const userId of new Set([...byUser.keys(), ...liveByUser.keys(), ...extras.keys()])) {
      const flags = detectFlags(byUser.get(userId) ?? [], WINDOW_DAYS, liveByUser.get(userId) ?? [], thresholds, extras.get(userId), locate).filter((f) => {
        const upTo = allowed.get(`${userId}:${FLAG_GROUP[f.kind]}`);
        return !upTo || SEVERITY_RANK[f.severity] > SEVERITY_RANK[upTo];
      });
      if (flags.length) detected.set(userId, flags);
    }
    return detected;
  }

  private store(detected: Map<string, DetectedFlag[]>, now: number): FlagEvent[] {
    const nowIso = new Date(now).toISOString();
    const events: Omit<FlagEvent, 'username' | 'email'>[] = [];
    transaction(this.db, () => {
      const existing = new Map(
        (this.db.prepare('SELECT * FROM moderation_flags').all() as unknown as FlagRow[]).map((r) => [`${r.user_id}:${r.kind}`, r]),
      );
      const upsert = this.db.prepare(
        `INSERT INTO moderation_flags (user_id, kind, severity, value, headline, details, admin_details, first_seen, last_seen, active, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open')
         ON CONFLICT (user_id, kind) DO UPDATE SET severity = excluded.severity, value = excluded.value,
           headline = excluded.headline, details = excluded.details, admin_details = excluded.admin_details,
           last_seen = excluded.last_seen, active = 1,
           first_seen = CASE WHEN moderation_flags.active = 0 THEN excluded.first_seen ELSE moderation_flags.first_seen END`,
      );
      const reopen = this.db.prepare(
        "UPDATE moderation_flags SET status = 'open', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, reviewed_value = NULL WHERE user_id = ? AND kind = ?",
      );
      const seen = new Set<string>();

      for (const [userId, flags] of detected) {
        for (const f of flags) {
          const key = `${userId}:${f.kind}`;
          seen.add(key);
          const before = existing.get(key);
          upsert.run(userId, f.kind, f.severity, f.value, f.headline, JSON.stringify(f.details), JSON.stringify(f.adminDetails), nowIso, nowIso);
          const event = { userId, kind: f.kind, severity: f.severity, headline: f.headline, details: f.details };
          // A reviewed flag comes back if it got clearly worse, or came back after stopping.
          if (before?.status === 'reviewed') {
            const worse =
              SEVERITY_RANK[f.severity] > SEVERITY_RANK[before.severity] ||
              f.value >= (before.reviewed_value ?? before.value) * REOPEN_GROWTH ||
              before.active === 0;
            if (worse) {
              reopen.run(userId, f.kind);
              events.push({ ...event, reason: 'reopened' });
            }
          } else if (!before || before.active === 0) {
            events.push({ ...event, reason: 'new' });
          } else if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[before.severity]) {
            events.push({ ...event, reason: 'worse' });
          }
        }
      }

      const deactivate = this.db.prepare('UPDATE moderation_flags SET active = 0 WHERE user_id = ? AND kind = ?');
      for (const [key, row] of existing) {
        if (!seen.has(key) && row.active === 1) deactivate.run(row.user_id, row.kind);
      }
    });
    this.checkedAt = nowIso;
    if (!events.length) return [];
    const who = this.db.prepare(
      `SELECT COALESCE((SELECT username FROM silo_users WHERE id = ?), (SELECT username FROM plays WHERE user_id = ? ORDER BY ended_at DESC LIMIT 1)) AS username,
              (SELECT email FROM silo_users WHERE id = ?) AS email`,
    );
    return events.map((e) => {
      const row = who.get(e.userId, e.userId, e.userId) as { username: string | null; email: string | null };
      return { ...e, username: row.username ?? `Deleted user ${e.userId}`, email: row.email };
    });
  }

  flags(options: { status?: 'open' | 'reviewed' | 'all'; userId?: string; includeAdminDetails: boolean; includeInactive?: boolean }): FlagsResponse {
    const where: string[] = [];
    const params: string[] = [];
    if (!options.includeInactive) where.push('f.active = 1');
    if (options.status && options.status !== 'all') {
      where.push('f.status = ?');
      params.push(options.status);
    }
    if (options.userId) {
      where.push('f.user_id = ?');
      params.push(options.userId);
    }
    const rows = this.db
      .prepare(
        `SELECT f.*, COALESCE(
           (SELECT username FROM silo_users u WHERE u.id = f.user_id),
           (SELECT username FROM plays p WHERE p.user_id = f.user_id AND p.username <> '' ORDER BY p.ended_at DESC LIMIT 1)
         ) AS username,
         (SELECT email FROM silo_users u WHERE u.id = f.user_id) AS email
         FROM moderation_flags f ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .all(...params) as unknown as (FlagRow & { username: string | null; email: string | null })[];
    const exceptions = new Map(this.activeExceptionRows(Date.now()).map((e) => [`${e.user_id}:${e.flag_group}`, e]));

    const flags = rows.map((r): ModerationFlag => ({
      id: `${r.user_id}:${r.kind}`,
      userId: r.user_id,
      username: r.username ?? `Deleted user ${r.user_id}`,
      email: r.email,
      kind: r.kind as FlagKind,
      group: FLAG_GROUP[r.kind as FlagKind] ?? 'sharing',
      severity: r.severity,
      headline: r.headline,
      details: parse(r.details),
      adminDetails: options.includeAdminDetails ? parse(r.admin_details) : [],
      firstSeenAt: r.first_seen,
      lastSeenAt: r.last_seen,
      active: r.active === 1,
      status: r.status,
      review: r.status === 'reviewed' && r.reviewed_by ? { by: r.reviewed_by, at: r.reviewed_at!, note: r.review_note } : null,
      exception: ((e) => (e ? { upTo: e.up_to, reason: e.reason, addedBy: e.added_by, expiresAt: e.expires_at } : null))(
        exceptions.get(`${r.user_id}:${FLAG_GROUP[r.kind as FlagKind] ?? 'sharing'}`),
      ),
    }));
    // Open before reviewed, then most serious, then most recent.
    flags.sort(
      (a, b) =>
        Number(a.status === 'reviewed') - Number(b.status === 'reviewed') ||
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.lastSeenAt.localeCompare(a.lastSeenAt),
    );

    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS open, SUM(severity = 'high') AS high FROM moderation_flags WHERE active = 1 AND status = 'open'`,
      )
      .get() as { open: number; high: number | null };

    return { flags, checkedAt: this.checkedAt, counts: { open: counts.open, openHigh: counts.high ?? 0 } };
  }

  /** Mark a flag as looked at. It reopens if the behaviour gets clearly worse. Adds a note to the user too. */
  review(flagId: string, actor: Actor, note: string): void {
    const [userId, kind] = splitFlagId(flagId);
    const row = this.db.prepare('SELECT * FROM moderation_flags WHERE user_id = ? AND kind = ?').get(userId, kind) as unknown as FlagRow | undefined;
    if (!row) throw new ModerationError('No such flag.', 404);
    const text = note.trim().slice(0, MAX_NOTE_LENGTH) || null;
    const now = new Date().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE moderation_flags SET status = 'reviewed', reviewed_by = ?, reviewed_at = ?, review_note = ?, reviewed_value = value WHERE user_id = ? AND kind = ?",
        )
        .run(actor.name, now, text, userId, kind);
      this.insertNote(userId, actor, `Reviewed flag: ${row.headline}.${text ? ` ${text}` : ''}`, now);
    });
  }

  reopen(flagId: string): void {
    const [userId, kind] = splitFlagId(flagId);
    const result = this.db
      .prepare(
        "UPDATE moderation_flags SET status = 'open', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, reviewed_value = NULL WHERE user_id = ? AND kind = ?",
      )
      .run(userId, kind);
    if (result.changes === 0) throw new ModerationError('No such flag.', 404);
  }

  /** One account's whole moderation history. Null if Almanac has never heard of it. */
  caseFile(userId: string, suspensions: SuspensionService, options: { actor: Actor; includeAdminDetails: boolean }): CaseFile | null {
    return buildCaseFile(this.db, this, suspensions, userId, options);
  }

  // ----- Exceptions -----

  /** Active exceptions, for everyone or one account, soonest to end first. */
  exceptions(userId?: string, now = Date.now()): FlagException[] {
    const who = this.db.prepare('SELECT username, email FROM silo_users WHERE id = ?');
    const fallback = this.db.prepare("SELECT username FROM plays WHERE user_id = ? AND username <> '' ORDER BY ended_at DESC LIMIT 1");
    return this.activeExceptionRows(now)
      .filter((e) => !userId || e.user_id === userId)
      .map((e) => {
        const u = who.get(e.user_id) as { username: string; email: string | null } | undefined;
        const name = u?.username ?? (fallback.get(e.user_id) as { username: string } | undefined)?.username ?? `Deleted user ${e.user_id}`;
        return {
          userId: e.user_id,
          username: name,
          email: u?.email ?? null,
          group: e.flag_group,
          upTo: e.up_to,
          reason: e.reason,
          addedBy: e.added_by,
          addedAt: e.added_at,
          expiresAt: e.expires_at,
        };
      })
      .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999') || a.username.localeCompare(b.username));
  }

  /** Allow an account something that would otherwise be flagged. Replaces any exception for the same kind. Written to the notes. */
  addException(userId: string, actor: Actor, input: { group: unknown; upTo: unknown; reason: unknown; days: unknown }, now = Date.now()): FlagException {
    const group = input.group as FlagGroup;
    if (!(group in GROUP_LABELS)) throw new ModerationError('Choose which kind of flag to allow.');
    const upTo = input.upTo as ExceptionLevel;
    if (upTo !== 'medium' && upTo !== 'high') throw new ModerationError('Choose how much to allow.');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 5) throw new ModerationError('Say why this account is allowed it, so other mods know.');
    if (reason.length > 1000) throw new ModerationError('Keep the reason under 1,000 characters.');
    const days = input.days === null || input.days === undefined || input.days === '' ? null : Number(input.days);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new ModerationError('Choose how long the exception lasts.');
    const known = this.db.prepare('SELECT 1 FROM silo_users WHERE id = ? UNION SELECT 1 FROM plays WHERE user_id = ? LIMIT 1').get(userId, userId);
    if (!known) throw new ModerationError('No such user.', 404);

    const at = new Date(now).toISOString();
    const expiresAt = days === null ? null : new Date(now + days * 86_400_000).toISOString();
    transaction(this.db, () => {
      const replacing = this.db.prepare('SELECT 1 FROM flag_exceptions WHERE user_id = ? AND flag_group = ?').get(userId, group);
      this.db
        .prepare(
          `INSERT INTO flag_exceptions (user_id, flag_group, up_to, reason, added_by, added_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, flag_group) DO UPDATE SET up_to = excluded.up_to, reason = excluded.reason, added_by = excluded.added_by,
             added_at = excluded.added_at, expires_at = excluded.expires_at`,
        )
        .run(userId, group, upTo, reason, actor.name, at, expiresAt);
      const scope = upTo === 'medium' ? `${LEVEL_LABELS.low} and “${LEVEL_LABELS.medium}” flags hidden, serious ones still show` : 'every flag hidden';
      const until = expiresAt ? `until ${new Date(expiresAt).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}` : 'until removed';
      this.insertNote(userId, actor, `${replacing ? 'Changed the' : 'Added an'} exception for ${GROUP_LABELS[group].title.toLowerCase()} (${scope}, ${until}): ${reason}`, at);
    });
    // Clear what it covers straight away. Not news, so no alerts.
    this.refresh(this.lastLive, now, { quiet: true });
    return this.exceptions(userId, now).find((e) => e.group === group)!;
  }

  removeException(userId: string, group: string, actor: Actor, now = Date.now()): void {
    if (!(group in GROUP_LABELS)) throw new ModerationError('No such exception.', 404);
    transaction(this.db, () => {
      const result = this.db.prepare('DELETE FROM flag_exceptions WHERE user_id = ? AND flag_group = ?').run(userId, group);
      if (result.changes === 0) throw new ModerationError('No such exception.', 404);
      this.insertNote(userId, actor, `Removed the exception for ${GROUP_LABELS[group as FlagGroup].title.toLowerCase()}. Those flags show again.`, new Date(now).toISOString());
    });
    this.refresh(this.lastLive, now, { quiet: true });
  }

  private activeExceptionRows(now: number): { user_id: string; flag_group: FlagGroup; up_to: ExceptionLevel; reason: string; added_by: string; added_at: string; expires_at: string | null }[] {
    return this.db
      .prepare('SELECT * FROM flag_exceptions WHERE expires_at IS NULL OR expires_at > ?')
      .all(new Date(now).toISOString()) as unknown as {
      user_id: string;
      flag_group: FlagGroup;
      up_to: ExceptionLevel;
      reason: string;
      added_by: string;
      added_at: string;
      expires_at: string | null;
    }[];
  }

  // ----- Notes -----

  notes(userId: string, actor: Actor): UserNote[] {
    const rows = this.db
      .prepare('SELECT * FROM user_notes WHERE user_id = ? ORDER BY created_at DESC, id DESC')
      .all(userId) as { id: number; user_id: string; author_id: number | null; author_name: string; body: string; created_at: string; updated_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      authorName: r.author_name,
      canEdit: actor.manageAllNotes || r.author_id === actor.id,
      body: r.body,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  addNote(userId: string, actor: Actor, body: string): void {
    const text = body.trim();
    if (!text) throw new ModerationError('Write something first.');
    if (text.length > MAX_NOTE_LENGTH) throw new ModerationError(`Notes can be up to ${MAX_NOTE_LENGTH} characters.`);
    this.insertNote(userId, actor, text, new Date().toISOString());
  }

  editNote(noteId: number, actor: Actor, body: string): void {
    this.requireEditable(noteId, actor);
    const text = body.trim();
    if (!text) throw new ModerationError('A note can’t be empty. Delete it instead.');
    if (text.length > MAX_NOTE_LENGTH) throw new ModerationError(`Notes can be up to ${MAX_NOTE_LENGTH} characters.`);
    this.db.prepare('UPDATE user_notes SET body = ?, updated_at = ? WHERE id = ?').run(text, new Date().toISOString(), noteId);
  }

  deleteNote(noteId: number, actor: Actor): void {
    this.requireEditable(noteId, actor);
    this.db.prepare('DELETE FROM user_notes WHERE id = ?').run(noteId);
  }

  // ----- Tags -----

  tags(): TagsResponse {
    const rows = this.db.prepare('SELECT user_id, tag FROM user_tags ORDER BY tag COLLATE NOCASE').all() as { user_id: string; tag: string }[];
    const byUser: Record<string, string[]> = {};
    const counts = new Map<string, { tag: string; users: number }>();
    for (const r of rows) {
      (byUser[r.user_id] ??= []).push(r.tag);
      const key = r.tag.toLowerCase();
      const c = counts.get(key);
      if (c) c.users++;
      else counts.set(key, { tag: r.tag, users: 1 });
    }
    return { byUser, all: [...counts.values()].sort((a, b) => b.users - a.users || a.tag.localeCompare(b.tag)) };
  }

  /** Replace a user's tags. Returns the cleaned list. */
  setTags(userId: string, actor: Actor, tags: unknown[]): string[] {
    const clean: string[] = [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const tag = t.replace(/\s+/g, ' ').trim();
      if (!tag) continue;
      if (tag.length > MAX_TAG_LENGTH) throw new ModerationError(`Tags can be up to ${MAX_TAG_LENGTH} characters.`);
      if (!clean.some((c) => c.toLowerCase() === tag.toLowerCase())) clean.push(tag);
    }
    if (clean.length > MAX_TAGS_PER_USER) throw new ModerationError(`A user can have up to ${MAX_TAGS_PER_USER} tags.`);

    const now = new Date().toISOString();
    transaction(this.db, () => {
      const current = (this.db.prepare('SELECT tag FROM user_tags WHERE user_id = ?').all(userId) as { tag: string }[]).map((r) => r.tag);
      const lower = clean.map((c) => c.toLowerCase());
      for (const tag of current) {
        if (!lower.includes(tag.toLowerCase())) this.db.prepare('DELETE FROM user_tags WHERE user_id = ? AND tag = ?').run(userId, tag);
      }
      const insert = this.db.prepare('INSERT OR IGNORE INTO user_tags (user_id, tag, added_by, added_at) VALUES (?, ?, ?, ?)');
      for (const tag of clean) insert.run(userId, tag, actor.name, now);
    });
    return clean;
  }

  private insertNote(userId: string, actor: Actor, body: string, at: string): void {
    this.db
      .prepare('INSERT INTO user_notes (user_id, author_id, author_name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, actor.id, actor.name, body, at, at);
  }

  private requireEditable(noteId: number, actor: Actor): void {
    const row = this.db.prepare('SELECT author_id FROM user_notes WHERE id = ?').get(noteId) as { author_id: number | null } | undefined;
    if (!row) throw new ModerationError('No such note.', 404);
    if (!actor.manageAllNotes && row.author_id !== actor.id) throw new ModerationError('You can only change your own notes.', 403);
  }
}

function splitFlagId(id: string): [string, string] {
  const i = id.lastIndexOf(':');
  if (i <= 0) throw new ModerationError('No such flag.', 404);
  return [id.slice(0, i), id.slice(i + 1)];
}

function parse(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
