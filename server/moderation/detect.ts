import type { FlagKind, Severity } from '../../shared/moderation.js';

/**
 * Spotting unusual account behaviour from play history.
 *
 * Thresholds were chosen from a real server's history (about 450 active
 * users): each flags roughly the top 1% of accounts or fewer, and normal
 * heavy viewers (families, bingers, phones changing IP) stay under them.
 */
export const THRESHOLDS = {
  /** Different networks playing at the same moment. */
  concurrentNetworks: { medium: 3, high: 4 },
  /** Different networks in the window. */
  networksInWindow: { low: 10, medium: 14 },
  /** Different devices in the window. */
  devicesInWindow: { low: 7, medium: 10 },
  /** Longest stretch of playback with no gap over 10 minutes, in hours. */
  nonstopHours: { medium: 24, high: 48 },
  /** Average hours of playback per day across the window. */
  dailyHours: { medium: 12, high: 18 },
  /** Titles played start to finish back to back with no real pauses. */
  backToBack: { medium: 20, high: 40 },
  /** The same, counting only movies. */
  backToBackMovies: { medium: 5, high: 8 },
} as const;

/** Plays this close together count as one continuous stretch. */
const CONTINUOUS_GAP_MS = 10 * 60_000;
/** For back-to-back: the next title started within this long of the last ending. */
const BACK_TO_BACK_GAP_MS = 3 * 60_000;
/** For back-to-back: a play paused for less than this counts as "no pauses". */
const MAX_PAUSE_SECONDS = 60;

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

function severityFor(value: number, levels: { low?: number; medium?: number; high?: number }): Severity | null {
  if (levels.high !== undefined && value >= levels.high) return 'high';
  if (levels.medium !== undefined && value >= levels.medium) return 'medium';
  if (levels.low !== undefined && value >= levels.low) return 'low';
  return null;
}

const plural = (n: number, word: string) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/** Check one user's plays from the window (and any live streams) for unusual behaviour. */
export function detectFlags(plays: PlayForDetection[], windowDays: number, live: LiveStreamForDetection[] = []): DetectedFlag[] {
  const flags: DetectedFlag[] = [];
  const sorted = [...plays].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const spans = sorted.map((p) => ({ play: p, start: Date.parse(p.startedAt), end: Date.parse(p.endedAt), network: networkOf(p.ip) }));

  // --- Several networks at the same moment ---------------------------------
  // At each play's start, which networks are playing?
  let worst = { count: 0, at: 0, players: [] as string[], networks: [] as string[] };
  const incidents: number[] = [];
  for (const s of spans) {
    const active = spans.filter((o) => o.start <= s.start && o.end > s.start);
    const networks = new Set(active.map((o) => o.network).filter((n): n is string => Boolean(n)));
    if (networks.size >= THRESHOLDS.concurrentNetworks.medium) {
      // Count separate incidents at least an hour apart.
      if (!incidents.length || s.start - incidents[incidents.length - 1]! > 3_600_000) incidents.push(s.start);
    }
    if (networks.size > worst.count) {
      worst = {
        count: networks.size,
        at: s.start,
        players: [...new Set(active.map((o) => o.play.player).filter((p): p is string => Boolean(p)))],
        networks: [...networks],
      };
    }
  }
  const liveNetworks = new Set(live.map((l) => networkOf(l.ip)).filter((n): n is string => Boolean(n)));
  const liveNow = liveNetworks.size >= THRESHOLDS.concurrentNetworks.medium;
  const concurrent = Math.max(worst.count, liveNetworks.size);
  const concurrentSeverity = severityFor(concurrent, THRESHOLDS.concurrentNetworks);
  if (concurrentSeverity) {
    const details: string[] = [];
    if (liveNow) details.push(`Happening right now: ${plural(liveNetworks.size, 'network')} at once.`);
    if (worst.count >= THRESHOLDS.concurrentNetworks.medium) {
      details.push(`Most recent peak: ${when(worst.at)}${worst.players.length ? ` on ${worst.players.join(', ')}` : ''}.`);
    }
    if (incidents.length > 1) details.push(`Seen ${plural(incidents.length, 'separate time')} in the last ${windowDays} days.`);
    flags.push({
      kind: 'concurrent_networks',
      severity: concurrentSeverity,
      value: concurrent * 100 + incidents.length,
      headline: `Streamed from ${concurrent} different networks at the same time`,
      details,
      adminDetails: [`Networks: ${(liveNow && liveNetworks.size >= worst.count ? [...liveNetworks] : worst.networks).join(', ')}`],
    });
  }

  // --- Many networks / devices in the window ---------------------------------
  const allNetworks = [...new Set(spans.map((s) => s.network).filter((n): n is string => Boolean(n)))];
  const networkSeverity = severityFor(allNetworks.length, THRESHOLDS.networksInWindow);
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

  const devices = new Set(sorted.map((p) => p.deviceId).filter(Boolean));
  const deviceSeverity = severityFor(devices.size, THRESHOLDS.devicesInWindow);
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
  const nonstopSeverity = severityFor(longestHours, THRESHOLDS.nonstopHours);
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
  const dailySeverity = severityFor(dailyHours, THRESHOLDS.dailyHours);
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
  let chain = { count: 0, movies: 0, start: 0, end: 0, media: 0 };
  let best = { count: 0, start: 0, end: 0, media: 0 };
  let bestMovies = { count: 0, start: 0, end: 0, media: 0 };
  let movieMedia = 0;
  let movieRunStart = 0;
  let prevEnd: number | null = null;
  for (const s of spans) {
    const clean = s.play.completed && (s.play.pausedSeconds ?? 0) < MAX_PAUSE_SECONDS;
    const continues = clean && prevEnd !== null && s.start - prevEnd < BACK_TO_BACK_GAP_MS && chain.count > 0;
    const media = s.play.durationSeconds ?? 0;
    if (continues) {
      chain.count++;
      chain.end = s.end;
      chain.media += media;
      if (s.play.mediaType === 'movie') {
        if (chain.movies === 0) {
          movieRunStart = s.start;
          movieMedia = 0;
        }
        chain.movies++;
        movieMedia += media;
      } else chain.movies = 0;
    } else {
      const isMovie = s.play.mediaType === 'movie';
      chain = clean ? { count: 1, movies: isMovie ? 1 : 0, start: s.start, end: s.end, media } : { count: 0, movies: 0, start: 0, end: 0, media: 0 };
      movieRunStart = s.start;
      movieMedia = isMovie ? media : 0;
    }
    if (chain.count > best.count) best = { count: chain.count, start: chain.start, end: chain.end, media: chain.media };
    if (chain.movies > bestMovies.count) bestMovies = { count: chain.movies, start: movieRunStart, end: s.end, media: movieMedia };
    prevEnd = s.end;
  }
  const chainSeverity = severityFor(best.count, THRESHOLDS.backToBack);
  const movieSeverity = severityFor(bestMovies.count, THRESHOLDS.backToBackMovies);
  if (chainSeverity || movieSeverity) {
    const useMovies = Boolean(movieSeverity && (!chainSeverity || (movieSeverity === 'high' && chainSeverity !== 'high')));
    const pick = useMovies ? bestMovies : best;
    const count = useMovies ? bestMovies.count : best.count;
    const noun = useMovies ? 'movies' : 'titles';
    // Finishing titles much faster than their running time means they weren't
    // being watched: a sign of downloading through the player.
    const elapsed = (pick.end - pick.start) / 1000;
    const tooFast = pick.media > 0 && elapsed < pick.media * 0.5;
    const minutesEach = Math.max(1, Math.round(elapsed / 60 / count));
    flags.push({
      kind: 'back_to_back',
      severity: tooFast || [chainSeverity, movieSeverity].includes('high') ? 'high' : 'medium',
      value: Math.max(best.count, bestMovies.count * 4),
      headline: tooFast
        ? `Finished ${count} ${noun} back to back, much faster than their running time`
        : `Played ${count} ${noun} back to back, each to the end`,
      details: [
        tooFast
          ? `From ${when(pick.start)} to ${when(pick.end)}: about ${minutesEach} minutes each, though together they run ${Math.round(pick.media / 3600)} hours.`
          : `From ${when(pick.start)} to ${when(pick.end)}, with under a minute of pausing in each and under 3 minutes between ${noun}.`,
        ...(useMovies || !bestMovies.count ? [] : [`Longest run of movies: ${bestMovies.count}.`]),
      ],
      adminDetails: [],
    });
  }

  return flags;
}
