import { HEALTH_DAYS, type HealthBaseline, type HealthIssue, type HealthOverview, type PlayerHealth, type UserHealth, type UserHealthResponse } from '../../shared/health.js';
import { cleanClientName } from '../activity/map.js';
import type { Database } from '../db/database.js';
import { QUICK_STOP_SECONDS } from '../reliability/reliability.js';
import { platformLabel } from '../../shared/platform.js';
import { platformKey } from '../stats/stats.js';
import { REASON_TEXT } from '../transcodes/doctor.js';
import { type DeviceInfo, appDescription, describeDevice, deviceTips, thirdPartyNote } from './devices.js';

const DAY_MS = 86_400_000;
/** Fewer plays than this and a couple of bad nights look like a pattern. */
export const MIN_PLAYS = 10;
/** A player needs this many plays across everyone before we blame the app itself. */
const MIN_PLAYER_PLAYS = 30;

/** Silo stopped hearing from the player before the end: a title watched to the end isn't a drop, however it ended. */
const DROPPED = "end_reason = 'expired' AND completed = 0";
/** Apps that end nearly every stream this way, for everyone, just never tell Silo they stopped. */
const UNREPORTED_SHARE = 0.9;
const UNREPORTED_MIN_PLAYS = 10;
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
  /** The model a signed-in device reported, e.g. "Amazon AFTKA". */
  model: string | null;
  version: string | null;
  plays: number;
  /** Plays whose drops can be judged (0 for apps that never say when they stop). */
  dropPlays: number;
  /** Ended without Silo hearing a stop, finished or not. */
  expired: number;
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
  /** The newest version of each app seen, from the last rows read. */
  private newest = new Map<string, string>();

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
    const rows = this.db
      .prepare(
        `SELECT p.user_id, MAX(p.username) AS username, p.client_name, p.device_platform, r.device_name AS model, MAX(p.client_version) AS version, COUNT(*) AS plays,
                SUM(${DROPPED}) AS dropped, SUM(end_reason = 'expired') AS expired, SUM(${QUICK}) AS quick, SUM(p.play_method = 'transcode') AS transcodes
         FROM plays p LEFT JOIN registered_devices r ON r.user_id = p.user_id AND r.device_id = p.device_id
         WHERE ${MEASURED} AND p.started_at >= ?
           -- No app name and no device: direct file streams from something that never reports in. Nothing to judge.
           AND COALESCE(p.client_name, '') <> ''
         GROUP BY p.user_id, p.client_name, p.device_platform, r.device_name`,
      )
      .all(since) as unknown as PlayerRow[];
    this.newest = newestVersions(rows);
    // Leave out drops from apps that never report stopping: for them every stream looks dropped.
    const unreported = unreportedApps(rows);
    for (const r of rows) {
      const silent = unreported.has(cleanClientName(r.client_name) ?? '');
      r.dropPlays = silent ? 0 : r.plays;
      if (silent) r.dropped = 0;
    }
    return rows;
  }

  private baseline(rows: PlayerRow[]): HealthBaseline {
    const t = rows.reduce(
      (a, r) => ({ plays: a.plays + r.plays, dropPlays: a.dropPlays + r.dropPlays, dropped: a.dropped + r.dropped, quick: a.quick + r.quick, transcodes: a.transcodes + r.transcodes }),
      { plays: 0, dropPlays: 0, dropped: 0, quick: 0, transcodes: 0 },
    );
    const rate = (n: number, of = t.plays) => (of ? n / of : 0);
    return { plays: t.plays, droppedRate: rate(t.dropped, t.dropPlays), quickStopRate: rate(t.quick), transcodeRate: rate(t.transcodes) };
  }

  /** Each app's totals across everyone, so viewers are compared with others on the same apps (phones drop more than TVs for everyone). */
  private playerRates(rows: PlayerRow[]): AppRates {
    const out: AppRates = new Map();
    for (const r of rows) {
      const key = playerKey(r.client_name, r.device_platform);
      const p = out.get(key) ?? { plays: 0, dropPlays: 0, dropped: 0, quick: 0, users: new Set<string>() };
      p.plays += r.plays;
      p.dropPlays += r.dropPlays;
      p.dropped += r.dropped;
      p.quick += r.quick;
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
      const key = `${playerKey(r.client_name, r.device_platform)}|${r.model ?? ''}`;
      const label = cleanClientName(r.client_name) ?? 'Unknown player';
      const device = describeDevice(r.device_platform, label, r.model);
      const about = device && device.kind !== 'computer' ? null : appDescription(label);
      const newest = this.newest.get(label);
      const newerVersion = newest && r.version && compareVersions(newest, r.version) > 0 ? newest : null;
      const p = players.get(key) ?? { label, platform: r.device_platform, device, version: r.version, newerVersion, about, plays: 0, dropPlays: 0, dropped: 0, quickStops: 0, transcodes: 0 };
      p.plays += r.plays;
      p.dropPlays += r.dropPlays;
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
      dropPlays: sum((p) => p.dropPlays),
      dropped: sum((p) => p.dropped),
      quickStops: sum((p) => p.quickStops),
      transcodes: sum((p) => p.transcodes),
      reasons: reasons.slice(0, 5).map((r) => ({ ...r, label: REASON_TEXT[r.reason] ?? r.reason.replace(/_/g, ' ') })),
      players: list,
      issues: [],
    };
  }
}

/** The newest version of each app (by name) that anyone used. */
function newestVersions(rows: PlayerRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const name = cleanClientName(r.client_name);
    if (!name || !r.version) continue;
    const best = out.get(name);
    if (!best || compareVersions(r.version, best) > 0) out.set(name, r.version);
  }
  return out;
}

/** Compare "1.2.10" with "1.2.9" numerically. Anything after the numbers is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Apps (by name) that end nearly every stream, for everyone, without telling Silo. */
function unreportedApps(rows: PlayerRow[]): Set<string> {
  const byApp = new Map<string, { plays: number; expired: number }>();
  for (const r of rows) {
    const name = cleanClientName(r.client_name);
    if (!name) continue;
    const a = byApp.get(name) ?? { plays: 0, expired: 0 };
    a.plays += r.plays;
    a.expired += r.expired;
    byApp.set(name, a);
  }
  return new Set([...byApp].filter(([, a]) => a.plays >= UNREPORTED_MIN_PLAYS && a.expired / a.plays >= UNREPORTED_SHARE).map(([name]) => name));
}

function playerKey(name: string | null, platform: string | null): string {
  return `${cleanClientName(name) ?? 'Unknown player'}|${platform ? platformKey(platform) : ''}`;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
/** "their Fire TV Stick Lite (Silo Android TV)", device first, as people think of it. */
const playerName = (p: PlayerHealth) => {
  const hardware =
    p.device?.kind === 'computer'
      ? p.device.detail
        ? `computer (${p.device.detail})`
        : null
      : p.device
        ? p.device.kind === 'browser' && p.device.name === 'web browser'
          ? 'web browser'
          : p.device.name
        : p.platform
          ? platformLabel(p.platform)
          : null;
  return hardware ? `their ${hardware} (${p.label})` : p.label;
};

const updateLine = (p: PlayerHealth) =>
  `Their ${p.label} is version ${p.version}, but others are on ${p.newerVersion}: updating the app is worth trying first.`;

/** What usually helps on this player's device, plus a word about third-party apps. */
function deviceHelp(p: PlayerHealth | undefined, topic: 'drops' | 'slowStarts' | 'transcoding', reasons: string[] = []): HealthIssue['device'] {
  if (!p?.device) return null;
  const info = p.device as DeviceInfo;
  const tips = deviceTips(info, topic, reasons);
  const note = thirdPartyNote(info, p.label);
  const all = note ? [...tips, note] : tips;
  return all.length ? { name: info.name, tips: all } : null;
}

type AppRates = Map<string, { plays: number; dropPlays: number; dropped: number; quick: number; users: Set<string> }>;

/**
 * How often streams drop or stop straight away for other people on the same
 * app, leaving this viewer out. Falls back to the server's rate when too few
 * others use it.
 */
function usualRates(user: UserHealth, base: HealthBaseline, rates: AppRates) {
  const mine = new Map<string, { dropPlays: number; dropped: number; plays: number; quick: number }>();
  for (const p of user.players) {
    const key = playerKey(p.label, p.platform);
    const m = mine.get(key) ?? { dropPlays: 0, dropped: 0, plays: 0, quick: 0 };
    m.dropPlays += p.dropPlays;
    m.dropped += p.dropped;
    m.plays += p.plays;
    m.quick += p.quickStops;
    mine.set(key, m);
  }
  const forPlayer = (p: PlayerHealth) => {
    const key = playerKey(p.label, p.platform);
    const all = rates.get(key);
    const me = mine.get(key)!;
    const dropPlays = (all?.dropPlays ?? 0) - me.dropPlays;
    const plays = (all?.plays ?? 0) - me.plays;
    return {
      dropRate: dropPlays >= MIN_PLAYER_PLAYS ? ((all?.dropped ?? 0) - me.dropped) / dropPlays : base.droppedRate,
      quickRate: plays >= MIN_PLAYER_PLAYS ? ((all?.quick ?? 0) - me.quick) / plays : base.quickStopRate,
    };
  };
  const expectedDrops = user.players.reduce((n, p) => n + p.dropPlays * forPlayer(p).dropRate, 0);
  const expectedQuick = user.players.reduce((n, p) => n + p.plays * forPlayer(p).quickRate, 0);
  return { forPlayer, expectedDrops, expectedQuick };
}

/** Clearly more than expected: at least twice as many, and a real difference. */
const wellAbove = (count: number, expected: number, of: number, margin: number) => of > 0 && count >= Math.max(expected * 2, expected + margin * of);

export function issuesFor(user: UserHealth, base: HealthBaseline, rates: AppRates): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const { plays } = user;
  if (plays < MIN_PLAYS) return issues;
  const usual = usualRates(user, base, rates);

  // --- Streams dropping ---
  if (user.dropPlays >= MIN_PLAYS && user.dropped >= 3 && wellAbove(user.dropped, usual.expectedDrops, user.dropPlays, 0.08)) {
    const severe = user.dropped >= 5 && user.dropped >= Math.max(usual.expectedDrops * 3, usual.expectedDrops + 0.2 * user.dropPlays);
    issues.push({
      kind: 'drops',
      severity: severe ? 'high' : 'medium',
      headline: `${user.dropped} of ${user.dropPlays} streams dropped (${pct(user.dropped / user.dropPlays)}; about ${pct(usual.expectedDrops / user.dropPlays)} for others on the same apps)`,
      advice: dropAdvice(user, base, usual.forPlayer),
      device: deviceHelp([...user.players].sort((a, b) => b.dropped - a.dropped)[0], 'drops'),
    });
  }

  // --- Streams stopping straight away ---
  // Quick stops are often just browsing, so the bar is higher than for drops.
  if (user.quickStops >= 6 && user.quickStops >= Math.max(usual.expectedQuick * 2.5, usual.expectedQuick + 0.25 * plays)) {
    const advice = ['A few quick stops are just browsing, but this many usually means streams struggle to start.'];
    const worst = [...user.players].filter((p) => p.quickStops > 0).sort((a, b) => b.quickStops - a.quickStops)[0];
    if (worst && user.players.length > 1 && worst.quickStops / user.quickStops >= 0.6) advice.push(`Most are on ${playerName(worst)}: ${worst.quickStops} of ${user.quickStops}.`);
    if (worst && worst.quickStops / user.quickStops >= 0.6 && worst.newerVersion) advice.push(updateLine(worst));
    if (user.transcodes / plays >= 0.5) advice.push('Most of their streams are converted, and converted streams take longer to start.');
    issues.push({
      kind: 'slowStarts',
      severity: user.quickStops >= usual.expectedQuick + 0.4 * plays ? 'medium' : 'low',
      headline: `${user.quickStops} of ${plays} streams stopped within seconds (${pct(user.quickStops / plays)}; about ${pct(usual.expectedQuick / plays)} for others on the same apps)`,
      advice,
      device: deviceHelp(worst, 'slowStarts'),
    });
  }

  // --- Nearly everything converted ---
  const transcodeRate = user.transcodes / plays;
  if (transcodeRate >= 0.75 && transcodeRate >= base.transcodeRate + 0.3) {
    const advice: string[] = [];
    const seen = new Set<string>();
    const main = [...user.players].sort((a, b) => b.transcodes - a.transcodes)[0];
    const device = deviceHelp(main, 'transcoding', user.reasons.map((r) => r.reason));
    // With advice for their device, one general line is enough.
    const general = device ? 1 : 2;
    for (const r of user.reasons) {
      const text = REASON_ADVICE[r.reason];
      if (text && !seen.has(text) && advice.length < general) {
        advice.push(text);
        seen.add(text);
      }
    }
    if (main && main.transcodes / Math.max(1, user.transcodes) >= 0.6) advice.unshift(`Mostly on ${playerName(main)}: ${main.transcodes} of ${user.transcodes} conversions.`);
    if (!user.reasons.length) advice.push('Almanac hasn’t caught one of their converted streams live yet, so it doesn’t know why. It will once it does.');
    issues.push({
      kind: 'transcoding',
      severity: 'low',
      headline: `${user.transcodes} of ${plays} streams converted (${pct(transcodeRate)}; usually ${pct(base.transcodeRate)})`,
      advice,
      device,
    });
  }
  return issues;
}

function dropAdvice(user: UserHealth, base: HealthBaseline, forPlayer: ReturnType<typeof usualRates>['forPlayer']): string[] {
  const advice: string[] = [];
  const bad = (p: PlayerHealth) => wellAbove(p.dropped, p.dropPlays * forPlayer(p).dropRate, p.dropPlays, 0.08);
  const worst = [...user.players].sort((a, b) => b.dropped - a.dropped)[0]!;
  const concentrated = worst.dropped / user.dropped >= 0.6;
  const judged = user.players.filter((p) => p.dropPlays >= 5);

  if (concentrated && user.players.length > 1) advice.push(`Most drops are on ${playerName(worst)}: ${worst.dropped} of ${user.dropped}.`);
  if (concentrated && worst.newerVersion) advice.push(updateLine(worst));
  // The app drops a lot for everyone: part of it is the app, not them.
  const appRate = forPlayer(worst).dropRate;
  if (concentrated && appRate >= Math.max(base.droppedRate * 2, base.droppedRate + 0.08)) {
    advice.push(`${worst.label} drops more streams than most apps for everyone (${pct(appRate)}), so part of this is the app. Updating it, or trying a different app, may help.`);
  }
  if (concentrated && judged.some((p) => p !== worst) && judged.filter((p) => p !== worst).every((p) => !bad(p))) {
    advice.push('Their other devices play fine, so it’s probably that device: restarting it, updating the app, or a wired connection or stronger Wi-Fi for it.');
  } else if (judged.length > 1 && judged.every(bad)) {
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
