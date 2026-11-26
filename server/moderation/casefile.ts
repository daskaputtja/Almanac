import { type CaseEvent, type CaseFile, coveredByException, GROUP_LABELS } from '../../shared/moderation.js';
import type { Database } from '../db/database.js';
import type { SuspensionService } from '../suspensions/suspensions.js';
import type { Actor, ModerationService } from './service.js';

const DAY_MS = 86_400_000;

/**
 * Everything about one account's moderation in one place: flags (including
 * ones that have gone quiet), notes, suspensions and exceptions, with a
 * timeline. Reviews, suspensions and exceptions all write notes, so the
 * notes are the record of who did what.
 */
export function buildCaseFile(
  db: Database,
  moderation: ModerationService,
  suspensions: SuspensionService,
  userId: string,
  options: { actor: Actor; includeAdminDetails: boolean },
  now = Date.now(),
): CaseFile | null {
  const silo = db.prepare('SELECT username, email, enabled, created_at, last_active_at FROM silo_users WHERE id = ?').get(userId) as
    | { username: string; email: string | null; enabled: number | null; created_at: string | null; last_active_at: string | null }
    | undefined;
  const played = db
    .prepare(
      `SELECT MAX(username) AS username, MAX(ended_at) AS last, SUM(started_at >= ?) AS recent
       FROM plays WHERE user_id = ?`,
    )
    .get(new Date(now - 30 * DAY_MS).toISOString(), userId) as { username: string | null; last: string | null; recent: number | null };
  if (!silo && !played.last) return null;

  const flags = moderation.flags({ userId, status: 'all', includeAdminDetails: options.includeAdminDetails, includeInactive: true }).flags;
  const notes = moderation.notes(userId, options.actor);
  const requests = suspensions.list({ userId }).requests;
  const exceptions = moderation.exceptions(userId, now);
  const tags = (db.prepare('SELECT tag FROM user_tags WHERE user_id = ? ORDER BY tag COLLATE NOCASE').all(userId) as { tag: string }[]).map((r) => r.tag);
  const downloads = (
    db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE user_id = ? AND created_at >= ? AND COALESCE(status, '') <> 'failed'").get(userId, new Date(now - 30 * DAY_MS).toISOString()) as {
      n: number;
    }
  ).n;

  const timeline: CaseEvent[] = [
    ...flags.map(
      (f): CaseEvent => ({
        at: f.firstSeenAt,
        kind: 'flag',
        title: `Flagged: ${f.headline}`,
        detail: `${GROUP_LABELS[f.group].title}${f.active ? '' : coveredByException(f) ? ' · hidden by an exception' : ' · no longer seen'}${f.status === 'reviewed' ? ' · reviewed' : ''}`,
        by: null,
        severity: f.severity,
      }),
    ),
    ...notes.map((n): CaseEvent => ({ at: n.createdAt, kind: 'note', title: n.body, detail: null, by: n.authorName, severity: null })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    user: {
      id: userId,
      username: silo?.username ?? played.username ?? `Deleted user ${userId}`,
      email: silo?.email ?? null,
      enabled: silo?.enabled == null ? null : silo.enabled === 1,
      inSilo: Boolean(silo),
      createdAt: silo?.created_at ?? null,
      lastActiveAt: silo?.last_active_at ?? null,
      tags,
    },
    summary: {
      openFlags: flags.filter((f) => f.active && f.status === 'open').length,
      flagsEver: flags.length,
      notes: notes.length,
      suspensions: requests.filter((r) => r.action === 'suspend' && r.status === 'done').length,
      pendingRequest: requests.some((r) => r.status === 'pending'),
      exceptions: exceptions.length,
      plays30Days: played.recent ?? 0,
      downloads30Days: downloads,
      lastPlayedAt: played.last,
    },
    flags,
    exceptions,
    suspensions: requests,
    timeline,
  };
}
