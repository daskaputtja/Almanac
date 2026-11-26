import { HEALTH_DAYS, type HealthBaseline, type HealthIssue, type HealthOverview, type PlayerHealth, type UserHealth, type UserHealthResponse } from '../../shared/health.js';
import { cleanClientName } from '../activity/map.js';
import type { Database } from '../db/database.js';
import { QUICK_STOP_SECONDS } from '../reliability/reliability.js';
import { platformLabel } from '../../shared/platform.js';
import { platformKey } from '../stats/stats.js';
import { REASON_TEXT } from '../transcodes/doctor.js';

const DAY_MS = 86_400_000;
/** Fewer plays than this and a couple of bad nights look like a pattern. */
export const MIN_PLAYS = 10;
/** A player needs this many plays across everyone before we blame the app itself. */
const MIN_PLAYER_PLAYS = 30;

const DROPPED = "end_reason = 'expired'";
const QUICK = `watched_seconds < ${QUICK_STOP_SECONDS}`;
/** Older imported history doesn't say how plays ended; leave it out. */
const MEASURED = 'end_reason IS NOT NULL AND watched_seconds IS NOT NULL';

/** What might help, for each reason Silo gives for converting a stream. */
const REASON_ADVICE: Record<string, string> = {
  video_codec_unsupported:
    'Their player can’t play the video format directly (often HEVC or AV1). A device or app that supports it would play without converting.',
  video_capability_unconfirmed: 'Their player didn’t confirm it supports the video format, so Silo converts to be safe. Updating the app often fixes this.',
  dynamic_range_unsupported: 'Their screen or player can’t show HDR, so HDR files are converted. SDR versions of the same titles would play directly.',
  resolution_limit: 'A resolution limit is converting their streams: check the quality setting in their player and the maximum quality on their account.',
  bandwidth_limit: 'Their bandwidth limit is lowering the quality. If their connection is fast enough, setting the player’s quality to Auto or Original avoids it.',
  bandwidth_cap: 'A bandwidth cap is lowering the quality of their streams.',
  server_bitrate_limit: 'The server’s bitrate limit is converting high-bitrate files for them.',
  buffering: 'Silo lowered the quality because their stream was buffering, which points to their connection.',
  quality_selected: 'They’ve picked a lower quality in the player. Setting it to Auto or Original lets files play directly.',
  subtitle_burn_in: 'Subtitles are being burned into the picture (usually image subtitles like PGS). Text subtitles (SRT) or no subtitles avoid that.',
  subtitle_unsupported: 'Their player can’t show the subtitle format, so subtitles are burned in. Text subtitles (SRT) avoid that.',
  audio_codec_unsupported: 'Their player can’t play the audio (often DTS or TrueHD). Setting the player’s audio to stereo or passthrough can help.',
  audio_channels_unsupported: 'Their player can’t handle surround audio, so it’s mixed down. Setting the player’s audio to stereo can help.',
  container_unsupported: 'Their player doesn’t support the file container, so files are repackaged or converted.',
  direct_play_failed: 'Direct play failed on their device and Silo fell back to converting.',
};

interface PlayerRow {
  user_id: string;
  username: string;
  client_name: string | null;
  device_platform: string | null;
  plays: number;
  dropped: number;
  quick: number;
  transcodes: number;
}

/**
 * Finds viewers who are having a rough time: streams dropping far more than
 * everyone else's, streams stopping straight away, or almost everything
 * being converted. Says which device it is and what might help.
 */
export class PlaybackHealth {
  constructor(private readonly db: Database) {}

  overview(now = Date.now()): HealthOverview {
    const since = new Date(now - HEALTH_DAYS * DAY_MS).toISOString();
    const rows = this.rows(since);
    const baseline = this.baseline(rows);
    const playerRates = this.playerRates(rows);
    const reasons = this.reasons(since);
    const emails = this.emails();

    const byUser = groupBy(rows, (r) => r.user_id);
    const users: UserHealth[] = [];
    let checked = 0;
    for (const [userId, list] of byUser) {
      const user = this.build(userId, list, reasons.get(userId) ?? [], emails.get(userId) ?? null);
      if (user.plays < MIN_PLAYS) continue;
      checked++;
      user.issues = issuesFor(user, baseline, playerRates);
      if (user.issues.length) users.push(user);
    }
    const weight = (u: UserHealth) => Math.max(...u.issues.map((i) => ({ high: 3, medium: 2, low: 1 })[i.severity]));
    users.sort((a, b) => weight(b) - weight(a) || b.dropped / b.plays - a.dropped / a.plays || b.plays - a.plays);
    return { days: HEALTH_DAYS, baseline, users, checked };
  }

  forUser(userId: string, now = Date.now()): UserHealthResponse | null {
    const since = new Date(now - HEALTH_DAYS * DAY_MS).toISOString();
    const rows = this.rows(since);
    const mine = rows.filter((r) => r.user_id === userId);
    if (!mine.length) return null;
    const baseline = this.baseline(rows);
    const user = this.build(userId, mine, this.reasons(since, userId).get(userId) ?? [], this.emails().get(userId) ?? null);
    const enoughPlays = user.plays >= MIN_PLAYS;
    if (enoughPlays) user.issues = issuesFor(user, baseline, this.playerRates(rows));
    return { days: HEALTH_DAYS, baseline, user, enoughPlays };
  }

  // --- Internals -------------------------------------------------------------

  private rows(since: string): PlayerRow[] {
    return this.db
      .prepare(
        `SELECT user_id, MAX(username) AS username, client_name, device_platform, COUNT(*) AS plays,
                SUM(${DROPPED}) AS dropped, SUM(${QUICK}) AS quick, SUM(play_method = 'transcode') AS transcodes
         FROM plays WHERE ${MEASURED} AND started_at >= ?
         GROUP BY user_id, client_name, device_platform`,
      )
      .all(since) as unknown as PlayerRow[];
  }

  private baseline(rows: PlayerRow[]): HealthBaseline {
    const t = rows.reduce((a, r) => ({ plays: a.plays + r.plays, dropped: a.dropped + r.dropped, quick: a.quick + r.quick, transcodes: a.transcodes + r.transcodes }), {
      plays: 0,
      dropped: 0,
      quick: 0,
      transcodes: 0,
    });
    const rate = (n: number) => (t.plays ? n / t.plays : 0);
    return { plays: t.plays, droppedRate: rate(t.dropped), quickStopRate: rate(t.quick), transcodeRate: rate(t.transcodes) };
  }

  /** Each player's drop rate across everyone, to tell a bad app from a bad connection. */
  private playerRates(rows: PlayerRow[]): Map<string, { plays: number; dropped: number; users: Set<string> }> {
    const out = new Map<string, { plays: number; dropped: number; users: Set<string> }>();
    for (const r of rows) {
      const key = playerKey(r.client_name, r.device_platform);
      const p = out.get(key) ?? { plays: 0, dropped: 0, users: new Set<string>() };
      p.plays += r.plays;
      p.dropped += r.dropped;
      p.users.add(r.user_id);
      out.set(key, p);
    }
    return out;
  }

  private reasons(since: string, userId?: string): Map<string, { reason: string; streams: number }[]> {
    const rows = this.db
      .prepare(
        `SELECT o.user_id, j.value AS reason, COUNT(*) AS streams FROM stream_observations o, json_each(o.reasons) j
         WHERE o.last_seen >= ? AND o.method = 'transcode' ${userId ? 'AND o.user_id = ?' : ''}
         GROUP BY o.user_id, j.value ORDER BY streams DESC`,
      )
      .all(...(userId ? [since, userId] : [since])) as { user_id: string; reason: string; streams: number }[];
    const out = new Map<string, { reason: string; streams: number }[]>();
    for (const r of rows) {
      const list = out.get(r.user_id) ?? [];
      list.push({ reason: r.reason, streams: r.streams });
      out.set(r.user_id, list);
    }
    return out;
  }

  private emails(): Map<string, string> {
    const rows = this.db.prepare('SELECT id, email FROM silo_users WHERE email IS NOT NULL').all() as { id: string; email: string }[];
    return new Map(rows.map((r) => [r.id, r.email]));
  }

  private build(userId: string, rows: PlayerRow[], reasons: { reason: string; streams: number }[], email: string | null): UserHealth {
    const players = new Map<string, PlayerHealth>();
    for (const r of rows) {
      const key = playerKey(r.client_name, r.device_platform);
      const p = players.get(key) ?? { label: cleanClientName(r.client_name) ?? 'Unknown player', platform: r.device_platform, plays: 0, dropped: 0, quickStops: 0, transcodes: 0 };
      p.plays += r.plays;
      p.dropped += r.dropped;
      p.quickStops += r.quick;
      p.transcodes += r.transcodes;
      players.set(key, p);
    }
    const list = [...players.values()].sort((a, b) => b.plays - a.plays);
    const sum = (pick: (p: PlayerHealth) => number) => list.reduce((n, p) => n + pick(p), 0);
    return {
      userId,
      username: rows.reduce((name, r) => r.username || name, ''),
      email,
      plays: sum((p) => p.plays),
      dropped: sum((p) => p.dropped),
      quickStops: sum((p) => p.quickStops),
      transcodes: sum((p) => p.transcodes),
      reasons: reasons.slice(0, 5).map((r) => ({ ...r, label: REASON_TEXT[r.reason] ?? r.reason.replace(/_/g, ' ') })),
      players: list,
      issues: [],
    };
  }
}

function playerKey(name: string | null, platform: string | null): string {
  return `${cleanClientName(name) ?? 'Unknown player'}|${platform ? platformKey(platform) : ''}`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const playerName = (p: PlayerHealth) => `${p.label}${p.platform ? ` on ${platformLabel(p.platform)}` : ''}`;

export function issuesFor(user: UserHealth, base: HealthBaseline, playerRates: Map<string, { plays: number; dropped: number; users: Set<string> }>): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const { plays } = user;
  if (plays < MIN_PLAYS) return issues;

  // --- Streams dropping ---
  const dropRate = user.dropped / plays;
  if (user.dropped >= 3 && dropRate >= Math.max(base.droppedRate * 2, base.droppedRate + 0.08)) {
    const severe = user.dropped >= 5 && dropRate >= Math.max(base.droppedRate * 3, base.droppedRate + 0.2);
    issues.push({
      kind: 'drops',
      severity: severe ? 'high' : 'medium',
      headline: `${user.dropped} of ${plays} streams dropped (${pct(dropRate)}; usually ${pct(base.droppedRate)})`,
      advice: dropAdvice(user, base, playerRates),
    });
  }

  // --- Streams stopping straight away ---
  const quickRate = user.quickStops / plays;
  if (user.quickStops >= 5 && quickRate >= Math.max(base.quickStopRate * 2, base.quickStopRate + 0.15)) {
    const advice = ['A few quick stops are just browsing, but this many usually means streams struggle to start.'];
    const worst = [...user.players].filter((p) => p.quickStops > 0).sort((a, b) => b.quickStops - a.quickStops)[0];
    if (worst && user.players.length > 1 && worst.quickStops / user.quickStops >= 0.6) advice.push(`Most are on ${playerName(worst)} (${worst.quickStops} of ${user.quickStops}).`);
    if (user.transcodes / plays >= 0.5) advice.push('Most of their streams are converted, and converted streams take longer to start.');
    issues.push({
      kind: 'slowStarts',
      severity: quickRate >= base.quickStopRate + 0.3 ? 'medium' : 'low',
      headline: `${user.quickStops} of ${plays} streams stopped within seconds (${pct(quickRate)}; usually ${pct(base.quickStopRate)})`,
      advice,
    });
  }

  // --- Nearly everything converted ---
  const transcodeRate = user.transcodes / plays;
  if (transcodeRate >= 0.75 && transcodeRate >= base.transcodeRate + 0.3) {
    const advice: string[] = [];
    const seen = new Set<string>();
    for (const r of user.reasons) {
      const text = REASON_ADVICE[r.reason];
      if (text && !seen.has(text) && advice.length < 2) {
        advice.push(text);
        seen.add(text);
      }
    }
    const main = [...user.players].sort((a, b) => b.transcodes - a.transcodes)[0];
    if (main && main.transcodes / Math.max(1, user.transcodes) >= 0.6) advice.unshift(`Mostly on ${playerName(main)} (${main.transcodes} of ${user.transcodes} conversions).`);
    if (!user.reasons.length) advice.push('Almanac hasn’t caught one of their converted streams live yet, so it doesn’t know why. It will once it does.');
    issues.push({
      kind: 'transcoding',
      severity: 'low',
      headline: `${user.transcodes} of ${plays} streams converted (${pct(transcodeRate)}; usually ${pct(base.transcodeRate)})`,
      advice,
    });
  }
  return issues;
}

function dropAdvice(user: UserHealth, base: HealthBaseline, playerRates: Map<string, { plays: number; dropped: number; users: Set<string> }>): string[] {
  const advice: string[] = [];
  const bad = (dropped: number, plays: number) => plays > 0 && dropped / plays >= Math.max(base.droppedRate * 2, base.droppedRate + 0.08);
  const worst = [...user.players].sort((a, b) => b.dropped - a.dropped)[0]!;
  const concentrated = worst.dropped / user.dropped >= 0.6;

  if (concentrated) {
    if (user.players.length > 1) advice.push(`Most drops are on ${playerName(worst)} (${worst.dropped} of ${user.dropped}).`);
    const everyone = playerRates.get(playerKey(worst.label, worst.platform));
    // Others' plays on that player, leaving this viewer out.
    const othersPlays = (everyone?.plays ?? 0) - worst.plays;
    const othersDropped = (everyone?.dropped ?? 0) - worst.dropped;
    if (everyone && everyone.users.size >= 3 && othersPlays >= MIN_PLAYER_PLAYS && bad(othersDropped, othersPlays)) {
      advice.push(
        `${worst.label} drops streams for other viewers too (${pct(othersDropped / othersPlays)} of their streams), so it’s likely the app rather than their connection. Updating the app, or trying a different one, should help.`,
      );
      return advice;
    }
    const others = user.players.filter((p) => p !== worst && p.plays >= 5);
    if (others.length && others.every((p) => !bad(p.dropped, p.plays))) {
      advice.push('Their other devices play fine, so it’s probably that device: restarting it, updating the app, or a wired connection or stronger Wi-Fi for it.');
      return advice;
    }
  }
  if (user.players.filter((p) => p.plays >= 5).length > 1 && user.players.filter((p) => p.plays >= 5).every((p) => bad(p.dropped, p.plays))) {
    advice.push('It happens on every device they use, which points to their internet connection or Wi-Fi rather than a device. A speed test, a wired connection, or a lower quality setting may help.');
  } else if (!concentrated) {
    advice.push('Drops are spread across their devices, which points to their internet connection or Wi-Fi. A speed test, a wired connection, or a lower quality setting may help.');
  } else {
    advice.push('It could be the device or their connection: restarting and updating the app is the quick thing to try, then a wired connection or a lower quality setting.');
  }
  if (user.transcodes / user.plays >= 0.5) advice.push('Most of their streams are converted, which needs a steadier connection than direct play.');
  return advice;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
