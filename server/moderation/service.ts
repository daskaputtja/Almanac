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
} from '../../shared/moderation.js';
import { type Database, transaction } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import { type DetectedFlag, type LiveStreamForDetection, type PlayForDetection, detectFlags } from './detect.js';

export const WINDOW_DAYS = 7;
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

export class ModerationService {
  private checkedAt: string | null = null;
  /** What was playing at the last check, reused for previews and re-checks after a settings change. */
  private lastLive = new Map<string, LiveStreamForDetection[]>();
  private readonly settings: SettingsStore;

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

  /** Save new thresholds (already validated) and re-check every account with them. */
  setThresholds(thresholds: FlagThresholds, by: string): void {
    this.settings.set(THRESHOLDS_KEY, thresholds, by);
    this.refresh(this.lastLive);
  }

  /** How many accounts the current and the proposed thresholds flag, without saving anything. */
  preview(proposed: FlagThresholds, now = Date.now()): FlagPreview {
    const count = (thresholds: FlagThresholds): PreviewCounts => {
      const detected = this.detectAll(this.lastLive, now, thresholds);
      const empty = () => ({ low: 0, medium: 0, high: 0 });
      const byKind: PreviewCounts['byKind'] = {
        concurrent_networks: empty(),
        many_networks: empty(),
        many_devices: empty(),
        nonstop: empty(),
        heavy_daily: empty(),
        back_to_back: empty(),
      };
      for (const flags of detected.values()) for (const f of flags) byKind[f.kind][f.severity]++;
      return { accounts: detected.size, byKind };
    };
    return { current: count(this.thresholds()), proposed: count(proposed) };
  }

  /**
   * Run every check over the last week of plays (and what's playing now),
   * then update the stored flags. Takes well under a second on a busy server.
   */
  refresh(liveByUser: Map<string, LiveStreamForDetection[]> = new Map(), now = Date.now()): void {
    this.lastLive = liveByUser;
    const detected = this.detectAll(liveByUser, now, this.thresholds());
    this.store(detected, now);
  }

  private detectAll(liveByUser: Map<string, LiveStreamForDetection[]>, now: number, thresholds: FlagThresholds): Map<string, DetectedFlag[]> {
    const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT user_id, started_at, ended_at, media_type, title, series_title, watched_seconds, paused_seconds,
                completed, duration_seconds, client_ip, device_id, client_name
         FROM plays WHERE started_at >= ? AND (watched_seconds IS NULL OR watched_seconds >= 30)`,
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
      });
    }

    const detected = new Map<string, DetectedFlag[]>();
    for (const userId of new Set([...byUser.keys(), ...liveByUser.keys()])) {
      const flags = detectFlags(byUser.get(userId) ?? [], WINDOW_DAYS, liveByUser.get(userId) ?? [], thresholds);
      if (flags.length) detected.set(userId, flags);
    }
    return detected;
  }

  private store(detected: Map<string, DetectedFlag[]>, now: number): void {
    const nowIso = new Date(now).toISOString();
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
          // A reviewed flag comes back if it got clearly worse, or came back after stopping.
          if (before?.status === 'reviewed') {
            const worse =
              SEVERITY_RANK[f.severity] > SEVERITY_RANK[before.severity] ||
              f.value >= (before.reviewed_value ?? before.value) * REOPEN_GROWTH ||
              before.active === 0;
            if (worse) reopen.run(userId, f.kind);
          }
        }
      }

      const deactivate = this.db.prepare('UPDATE moderation_flags SET active = 0 WHERE user_id = ? AND kind = ?');
      for (const [key, row] of existing) {
        if (!seen.has(key) && row.active === 1) deactivate.run(row.user_id, row.kind);
      }
    });
    this.checkedAt = nowIso;
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
         ) AS username
         FROM moderation_flags f ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .all(...params) as unknown as (FlagRow & { username: string | null })[];

    const flags = rows.map((r): ModerationFlag => ({
      id: `${r.user_id}:${r.kind}`,
      userId: r.user_id,
      username: r.username ?? `Deleted user ${r.user_id}`,
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
