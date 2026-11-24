import { DEFAULT_THRESHOLDS, type FlagKind, type FlagThresholds, type Severity, type ThresholdLevels } from '../../shared/moderation.js';

/**
 * Spotting unusual account behaviour from play history. The levels each
 * check flags at are adjustable in Settings; see DEFAULT_THRESHOLDS for the
 * defaults and why they were chosen.
 */
export const THRESHOLDS = DEFAULT_THRESHOLDS;

/** Plays this close together count as one continuous stretch. */
const CONTINUOUS_GAP_MS = 10 * 60_000;
/** For back-to-back: the next title started within this long of the last ending. */
const BACK_TO_BACK_GAP_MS = 3 * 60_000;
/** A play that timed out stops counting as "playing" this long before its recorded end. */
const STALE_SESSION_MS = 10 * 60_000;
/** For back-to-back: a play paused for less than this counts as "no pauses". */
const MAX_PAUSE_SECONDS = 60;
/** A play marked finished but watched for less than this share of its length was skipped through. */
const WATCHED_THROUGH_SHARE = 0.7;

export interface PlayForDetection {
  startedAt: string;
  endedAt: string;
  mediaType: string;
  title: string;
  seriesTitle: string | null;
  watchedSeconds: number | null;
  pausedSeconds: number | null;
  completed: boolean;
  durationSeconds: number | null;
  ip: string | null;
  deviceId: string | null;
  player: string | null;
  /** How the play ended; "expired" means Silo stopped hearing from the player. */
  endReason?: string | null;
}

/** Where an address is, from the local geolocation database. */
export type Locate = (ip: string) => { country: string; city: string | null } | null;

/** Offline downloads and signed-in devices, from Silo's admin API. */
export interface AccountExtras {
  /** Downloads started in the window, including ones since deleted. */
  downloads: { createdAt: string; sizeBytes: number | null; title: string; deviceName: string | null }[];
  /** Signed-in devices used in the last 30 days. */
  activeDevices: { name: string; platform: string | null }[];
}

export interface LiveStreamForDetection {
  ip: string | null;
  player: string | null;
}

export interface DetectedFlag {
  kind: FlagKind;
  severity: Severity;
  /** The measured number, used to reopen a reviewed flag if it gets worse. */
  value: number;
  headline: string;
  details: string[];
  /** Only shown to admins: mentions networks. */
  adminDetails: string[];
}

/**
 * The network an IP address belongs to: the first three parts of an IPv4
 * address (a /24) or the first four of an IPv6 one (a /64). Phones and home
 * routers move around inside these, so comparing networks rather than exact
 * addresses avoids flagging someone just because their IP changed.
 */
export function networkOf(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(v4)) return 'local network';
    return `${v4.split('.').slice(0, 3).join('.')}.x`;
  }
  if (ip.includes(':')) {
    if (/^(fe80|fc|fd)/i.test(ip) || ip === '::1') return 'local network';
    return `${ip.split(':').slice(0, 4).join(':')}::/64`;
  }
  return ip;
}

/**
 * A time in a flag's text. Written as a token the dashboard replaces with the
 * viewer's local time, e.g. "{{time:2026-11-18T05:01:00.000Z}}".
 */
const when = (ms: number) => `{{time:${new Date(ms).toISOString()}}}`;

function severityFor(value: number, levels: ThresholdLevels): Severity | null {
  if (!levels.enabled) return null;
  if (levels.high !== undefined && value >= levels.high) return 'high';
  if (levels.medium !== undefined && value >= levels.medium) return 'medium';
  if (levels.low !== undefined && value >= levels.low) return 'low';
  return null;
}

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/** Check one user's plays from the window (and any live streams) for unusual behaviour. */
/** The lowest level a check flags at. */
function lowest(levels: ThresholdLevels): number {
  return Math.min(...[levels.low, levels.medium, levels.high].filter((v): v is number => typeof v === 'number'));
}

export function detectFlags(
  plays: PlayForDetection[],
  windowDays: number,
  live: LiveStreamForDetection[] = [],
  thresholds: FlagThresholds = DEFAULT_THRESHOLDS,
  extras: AccountExtras = { downloads: [], activeDevices: [] },
  locate: Locate = () => null,
): DetectedFlag[] {
  const T = thresholds;
  const flags: DetectedFlag[] = [];
  flags.push(...accountFlags(extras, windowDays, T));
  const sorted = [...plays].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const spans = sorted.map((p) => {
    const start = Date.parse(p.startedAt);
    const end = Date.parse(p.endedAt);
    // A play that timed out was probably dead for a while before Silo gave up on it
    // (a phone that lost signal, say), so for being in two places at once its end
    // doesn't count.
    const liveUntil = p.endReason === 'expired' ? Math.max(start, end - STALE_SESSION_MS) : end;
    return { play: p, start, end, liveUntil, network: networkOf(p.ip) };
  });

  // --- Several networks at the same moment ---------------------------------
  // At each play's start, which networks are playing?
  let worst = { count: 0, at: 0, players: [] as string[], networks: [] as string[], ips: [] as string[] };
  const incidents: number[] = [];
  for (const s of spans) {
    // A device can only be in one place: keep each device's newest play.
    const newestPerDevice = new Map<string, (typeof spans)[number]>();
    for (const o of spans) {
      if (o.start > s.start || o.liveUntil <= s.start) continue;
      const key = o.play.deviceId ?? `${o.play.ip}|${o.play.player}`;
      const held = newestPerDevice.get(key);
      if (!held || o.start > held.start) newestPerDevice.set(key, o);
    }
    const active = [...newestPerDevice.values()];
    const networks = new Set(active.map((o) => o.network).filter((n): n is string => Boolean(n)));
    if (networks.size >= lowest(T.concurrentNetworks)) {
      // Count separate incidents at least an hour apart.
      if (!incidents.length || s.start - incidents[incidents.length - 1]! > 3_600_000) incidents.push(s.start);
    }
    if (networks.size > worst.count) {
      worst = {
        count: networks.size,
        at: s.start,
        players: [...new Set(active.map((o) => o.play.player).filter((p): p is string => Boolean(p)))],
        networks: [...networks],
        ips: active.map((o) => o.play.ip).filter((ip): ip is string => Boolean(ip)),
      };
    }
  }
  const liveNetworks = new Set(live.map((l) => networkOf(l.ip)).filter((n): n is string => Boolean(n)));
  const liveNow = liveNetworks.size >= lowest(T.concurrentNetworks);
  const concurrent = Math.max(worst.count, liveNetworks.size);
  const concurrentSeverity = severityFor(concurrent, T.concurrentNetworks);
  if (concurrentSeverity) {
    const details: string[] = [];
    if (liveNow) details.push(`Happening right now: ${plural(liveNetworks.size, 'network')} at once.`);
    if (worst.count >= lowest(T.concurrentNetworks)) {
      details.push(`Most recent peak: ${when(worst.at)}${worst.players.length ? ` on ${worst.players.join(', ')}` : ''}.`);
    }
    if (incidents.length > 1) details.push(`Seen ${plural(incidents.length, 'separate time')} in the last ${windowDays} days.`);
    // Where those streams were: countries for everyone, towns for admins.
    const peakIps = liveNow && liveNetworks.size >= worst.count ? live.map((l) => l.ip).filter((ip): ip is string => Boolean(ip)) : worst.ips;
    const places = peakIps.map((ip) => locate(ip)).filter((l): l is NonNullable<ReturnType<Locate>> => Boolean(l) && l!.country !== 'LAN');
    const countries = [...new Set(places.map((l) => countryName(l.country)))];
    const towns = [...new Set(places.map((l) => [l.city, countryName(l.country)].filter(Boolean).join(', ')))];
    if (countries.length > 1) details.push(`At that moment the streams were in ${countries.length} different countries: ${countries.join(', ')}.`);
    else if (countries.length === 1) details.push(`All in ${countries[0]}${towns.length > 1 ? `, in ${towns.length} different places` : ''}. Mobile data can make one phone look like it’s on several networks, so check the details.`);
    flags.push({
      kind: 'concurrent_networks',
      severity: concurrentSeverity,
      value: concurrent * 100 + incidents.length,
      headline: `Streamed from ${concurrent} different networks at the same time`,
      details,
      adminDetails: [
        `Networks: ${(liveNow && liveNetworks.size >= worst.count ? [...liveNetworks] : worst.networks).join(', ')}`,
        ...(towns.length ? [`Places: ${towns.join('; ')}`] : []),
      ],
    });
  }

  // --- Many networks / devices in the window ---------------------------------
  const allNetworks = [...new Set(spans.map((s) => s.network).filter((n): n is string => Boolean(n)))];
  const networkSeverity = severityFor(allNetworks.length, T.networksInWindow);
  if (networkSeverity) {
    flags.push({
      kind: 'many_networks',
      severity: networkSeverity,
      value: allNetworks.length,
      headline: `Used ${allNetworks.length} different networks in ${windowDays} days`,
      details: ['Most people use 2 to 5. Phones on mobile data can add a few.'],
      adminDetails: [`Networks: ${allNetworks.join(', ')}`],
    });
  }

  // Web browsers can get a new device ID whenever cookies are cleared or a private
  // window is used, so browsers count as whichever is fewer: their IDs, or the
  // networks they were used on.
  const isWeb = (p: PlayForDetection) => /web/i.test(p.player ?? '');
  const appDevices = new Set(sorted.filter((p) => p.deviceId && !isWeb(p)).map((p) => p.deviceId));
  const web = sorted.filter((p) => p.deviceId && isWeb(p));
  const webCount = Math.min(new Set(web.map((p) => p.deviceId)).size, new Set(web.map((p) => networkOf(p.ip) ?? p.ip)).size);
  const devices = { size: appDevices.size + webCount };
  const deviceSeverity = severityFor(devices.size, T.devicesInWindow);
  if (deviceSeverity) {
    const players = [...new Set(sorted.map((p) => p.player).filter(Boolean))];
    flags.push({
      kind: 'many_devices',
      severity: deviceSeverity,
      value: devices.size,
      headline: `Used ${devices.size} different devices in ${windowDays} days`,
      details: [`Players: ${players.slice(0, 8).join(', ')}${players.length > 8 ? ` and ${players.length - 8} more` : ''}.`],
      adminDetails: [],
    });
  }

  // --- Long stretches without a break ----------------------------------------
  let longest = { ms: 0, start: 0, end: 0, titles: 0 };
  let busyMs = 0;
  let run: { start: number; end: number; titles: number } | null = null;
  const closeRun = () => {
    if (!run) return;
    busyMs += run.end - run.start;
    if (run.end - run.start > longest.ms) longest = { ms: run.end - run.start, start: run.start, end: run.end, titles: run.titles };
  };
  for (const s of spans) {
    if (run && s.start - run.end <= CONTINUOUS_GAP_MS) {
      run.end = Math.max(run.end, s.end);
      run.titles++;
    } else {
      closeRun();
      run = { start: s.start, end: s.end, titles: 1 };
    }
  }
  closeRun();
  const longestHours = longest.ms / 3_600_000;
  const nonstopSeverity = severityFor(longestHours, T.nonstopHours);
  if (nonstopSeverity) {
    flags.push({
      kind: 'nonstop',
      severity: nonstopSeverity,
      value: Math.round(longestHours),
      headline: `Played for ${Math.round(longestHours)} hours without a break`,
      details: [`From ${when(longest.start)} to ${when(longest.end)}, ${plural(longest.titles, 'title')}, never stopping for more than 10 minutes.`],
      adminDetails: [],
    });
  }

  const dailyHours = busyMs / 3_600_000 / windowDays;
  const dailySeverity = severityFor(dailyHours, T.dailyHours);
  if (dailySeverity) {
    flags.push({
      kind: 'heavy_daily',
      severity: dailySeverity,
      value: Math.round(dailyHours * 10) / 10,
      headline: `Averages ${dailyHours.toFixed(1)} hours of playback a day`,
      details: [`Over the last ${windowDays} days. Most people average under 2 hours.`],
      adminDetails: [],
    });
  }

  // --- Back-to-back full plays -----------------------------------------------
  // Title after title watched start to finish, in real time, with hardly any
  // pausing. Measured in hours of content, so a streak of 5-minute cartoons on
  // autoplay isn't mistaken for a hundred films. Watching in real time is also
  // how people binge or fall asleep with the TV on, so on its own this is never
  // more than worth a look.
  let streak = { ms: 0, titles: 0, movies: 0, start: 0, end: 0, shows: new Map<string, number>() };
  let best = { ...streak, shows: new Map<string, number>() };
  let prevEnd: number | null = null;
  for (const s of spans) {
    const p = s.play;
    // Jumped to the end rather than watched: skipping through, not playing it.
    const skippedThrough =
      p.completed && p.durationSeconds && p.watchedSeconds != null && p.watchedSeconds < p.durationSeconds * WATCHED_THROUGH_SHARE;
    const watchedThrough = p.completed && !skippedThrough && (p.pausedSeconds ?? 0) < MAX_PAUSE_SECONDS;
    const media = (p.durationSeconds ?? (s.end - s.start) / 1000) * 1000;
    const label = p.seriesTitle ?? p.title;
    if (watchedThrough && prevEnd !== null && s.start - prevEnd < BACK_TO_BACK_GAP_MS && streak.titles > 0) {
      streak.ms += media;
      streak.titles++;
      streak.end = s.end;
      if (p.mediaType === 'movie') streak.movies++;
      streak.shows.set(label, (streak.shows.get(label) ?? 0) + 1);
    } else if (watchedThrough) {
      streak = { ms: media, titles: 1, movies: p.mediaType === 'movie' ? 1 : 0, start: s.start, end: s.end, shows: new Map([[label, 1]]) };
    } else {
      streak = { ms: 0, titles: 0, movies: 0, start: 0, end: 0, shows: new Map() };
    }
    if (streak.ms > best.ms) best = { ...streak, shows: new Map(streak.shows) };
    prevEnd = s.end;
  }
  const runHours = best.ms / 3_600_000;
  const runSeverity = severityFor(runHours, T.backToBackHours);
  if (runSeverity) {
    const top = [...best.shows].sort((a, b) => b[1] - a[1]);
    const mostly = top[0] && top[0][1] / best.titles >= 0.6 ? top[0] : null;
    flags.push({
      kind: 'back_to_back',
      severity: runSeverity,
      value: Math.round(runHours * 10) / 10,
      headline: `Watched ${Math.round(runHours)} hours of titles back to back, each to the end`,
      details: [
        `From ${when(best.start)} to ${when(best.end)}: ${plural(best.titles, 'title')}${best.movies ? `, ${plural(best.movies, 'movie')}` : ''}, with under a minute of pausing in each and under 3 minutes between them.`,
        mostly
          ? `Mostly ${mostly[0]} (${mostly[1]} of ${best.titles}). Autoplay with the TV left on looks just like this.`
          : `Including ${top.slice(0, 4).map(([t]) => t).join(', ')}${top.length > 4 ? ` and ${top.length - 4} more` : ''}.`,
      ],
      adminDetails: [],
    });
  }

  return flags;
}

/** Flags from offline downloads and signed-in devices. */
function accountFlags(extras: AccountExtras, windowDays: number, T: FlagThresholds): DetectedFlag[] {
  const flags: DetectedFlag[] = [];

  const count = extras.downloads.length;
  const gb = extras.downloads.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0) / 1e9;
  const byCount = severityFor(count, T.downloadsInWindow);
  const bySize = severityFor(gb, T.downloadGbInWindow);
  if (byCount || bySize) {
    const severity = [byCount, bySize].includes('high') ? 'high' : [byCount, bySize].includes('medium') ? 'medium' : 'low';
    const devices = [...new Set(extras.downloads.map((d) => d.deviceName).filter((n): n is string => Boolean(n)))];
    const titles = [...new Set(extras.downloads.map((d) => d.title))];
    const sorted = [...extras.downloads].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    flags.push({
      kind: 'heavy_downloads',
      severity,
      value: Math.max(count, Math.round(gb / 5)),
      headline: `Downloaded ${plural(count, 'title')} (${formatGb(gb)}) for offline viewing in ${windowDays} days`,
      details: [
        `From ${when(Date.parse(sorted[0]!.createdAt))} to ${when(Date.parse(sorted[sorted.length - 1]!.createdAt))}${devices.length ? ` to ${devices.slice(0, 4).join(', ')}${devices.length > 4 ? ` and ${devices.length - 4} more` : ''}` : ''}.`,
        `Including ${titles.slice(0, 5).join(', ')}${titles.length > 5 ? ` and ${titles.length - 5} more` : ''}.`,
      ],
      adminDetails: [],
    });
  }

  const devices = extras.activeDevices.length;
  const deviceSeverity = severityFor(devices, T.devicesRegistered);
  if (deviceSeverity) {
    const platforms = new Map<string, number>();
    for (const d of extras.activeDevices) platforms.set(d.platform ?? 'unknown', (platforms.get(d.platform ?? 'unknown') ?? 0) + 1);
    flags.push({
      kind: 'many_registered_devices',
      severity: deviceSeverity,
      value: devices,
      headline: `${devices} devices signed in and used in the last 30 days`,
      details: [
        `By kind: ${[...platforms].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${n} ${p}`).join(', ')}.`,
        'Most accounts have under 10. A family with several TVs and phones can reach the low teens.',
      ],
      adminDetails: [],
    });
  }
  return flags;
}

function formatGb(gb: number): string {
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${Math.round(gb)} GB`;
}

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
function countryName(code: string): string {
  try {
    return COUNTRY_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}
