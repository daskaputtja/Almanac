import { RELIABILITY_RANGES, type ReliabilityCounts, type ReliabilityGroup, type ReliabilityRange, type ReliabilityResponse } from '../../shared/reliability.js';
import { cleanClientName } from '../activity/map.js';
import type { Database } from '../db/database.js';
import type { StaffAlerts } from '../notify/staff.js';
import type { ServerSource } from '../silo/client.js';
import type { SiloPlaybackActivity } from '../silo/types.js';
import { platformKey } from '../stats/stats.js';

/** A play that ended within this many seconds counts as a quick stop. */
export const QUICK_STOP_SECONDS = 10;
const TYPICAL_DAYS = 28;
const SILO_CACHE_MS = 5 * 60_000;

// --- Alerting ------------------------------------------------------------------
const CHECK_EVERY_MS = 15 * 60_000;
/** Look at plays that ended in the last hour… */
const ALERT_WINDOW_MS = 60 * 60_000;
/** …compared with the same hour of the day over the previous two weeks. */
const ALERT_BASELINE_DAYS = 14;
/** Too few plays and the rate is just noise. */
export const ALERT_MIN_PLAYS = 40;

const DROPPED = "end_reason = 'expired'";
const QUICK = `watched_seconds < ${QUICK_STOP_SECONDS}`;
/** Older history imported from Silo doesn't say how plays ended or how long they ran: leave it out. */
const MEASURED = 'end_reason IS NOT NULL AND watched_seconds IS NOT NULL';

/**
 * How reliably streams are playing. Silo says how many sessions started and
 * how many were watched to the end; Almanac's history says how each one
 * ended, which shows streams dropping and streams that stop straight away.
 */
export class ReliabilityService {
  private siloCache = new Map<number, { at: number; value: SiloPlaybackActivity | null }>();
  /** Also told about alerts (for push notifications to the phone app). */
  onAlert: ((message: { title: string; body: string; path?: string }) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly source: ServerSource,
    private readonly staff: StaffAlerts | null = null,
    private readonly log: (message: string) => void = console.log,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.checkAlert().catch((err) => this.log(`Reliability check: ${err instanceof Error ? err.message : String(err)}`));
      this.timer = setTimeout(tick, CHECK_EVERY_MS);
    };
    this.timer = setTimeout(tick, 2 * 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async report(range: ReliabilityRange, now = Date.now()): Promise<ReliabilityResponse> {
    const { hours, bucketHours } = RELIABILITY_RANGES[range];
    const from = now - hours * 3_600_000;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(now).toISOString();

    const totals = this.counts('started_at >= ? AND started_at < ?', fromIso, toIso);
    // "Usual" is the median day of the four weeks before, so one bad day (an app
    // stuck retrying, say) doesn't skew it.
    const days = this.db
      .prepare(
        `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS plays, SUM(${DROPPED}) AS dropped, SUM(${QUICK}) AS quick
         FROM plays WHERE ${MEASURED} AND started_at >= ? AND started_at < ? GROUP BY day HAVING plays >= 50`,
      )
      .all(new Date(from - TYPICAL_DAYS * 86_400_000).toISOString(), fromIso) as { plays: number; dropped: number; quick: number }[];
    const typicalOf = (pick: (d: { plays: number; dropped: number; quick: number }) => number) =>
      days.length >= 3 ? median(days.map((d) => pick(d) / d.plays)) : null;

    // Buckets in the server's view of time: hours, or days.
    const bucketMs = bucketHours * 3_600_000;
    const rows = this.db
      .prepare(
        `SELECT started_at, ${DROPPED} AS dropped, ${QUICK} AS quick FROM plays WHERE ${MEASURED} AND started_at >= ? AND started_at < ?`,
      )
      .all(fromIso, toIso) as { started_at: string; dropped: number; quick: number }[];
    const firstBucket = Math.floor(from / bucketMs) * bucketMs;
    const count = Math.ceil((now - firstBucket) / bucketMs);
    const buckets: [number, number, number, number][] = Array.from({ length: count }, (_, i) => [firstBucket + i * bucketMs, 0, 0, 0]);
    for (const r of rows) {
      const b = buckets[Math.floor((Date.parse(r.started_at) - firstBucket) / bucketMs)];
      if (!b) continue;
      b[1]++;
      b[2] += r.dropped;
      b[3] += r.quick;
    }

    return {
      range,
      from: fromIso,
      to: toIso,
      silo: await this.siloSummary(hours),
      totals,
      typical: { droppedRate: typicalOf((d) => d.dropped), quickStopRate: typicalOf((d) => d.quick) },
      buckets,
      bucketHours,
      players: this.byPlayer(fromIso, toIso),
      methods: this.byMethod(fromIso, toIso),
    };
  }

  /**
   * Post to the staff channel when streams start dropping far more than usual
   * for the time of day, and again when things are back to normal.
   */
  async checkAlert(now = Date.now()): Promise<'alerted' | 'recovered' | null> {
    if (!this.staff) return null;
    const toStaff = this.staff.wants('reliability');
    if (!toStaff && !this.onAlert) return null;
    const windowStart = new Date(now - ALERT_WINDOW_MS).toISOString();
    const current = this.counts('ended_at >= ? AND ended_at < ?', windowStart, new Date(now).toISOString());

    // The same hour on each of the previous days; the median, so one bad day doesn't count.
    const dayRates: number[] = [];
    for (let d = 1; d <= ALERT_BASELINE_DAYS; d++) {
      const end = now - d * 86_400_000;
      const c = this.counts('ended_at >= ? AND ended_at < ?', new Date(end - ALERT_WINDOW_MS).toISOString(), new Date(end).toISOString());
      if (c.plays >= 10) dayRates.push(c.dropped / c.plays);
    }
    if (dayRates.length < 5) return null; // not enough history yet
    const typical = median(dayRates);
    const rate = current.plays ? current.dropped / current.plays : 0;
    const state = this.staff.state();
    const pct = (r: number) => `${Math.round(r * 100)}%`;

    if (!state.alerting && current.plays >= ALERT_MIN_PLAYS && rate >= Math.max(typical * 2, typical + 0.1)) {
      const players = this.byPlayer(windowStart, new Date(now).toISOString())
        .filter((p) => p.dropped > 0)
        .sort((a, b) => b.dropped - a.dropped)
        .slice(0, 5);
      this.onAlert?.({ title: 'Streams are dropping more than usual', body: `${pct(rate)} of streams in the last hour dropped; usually about ${pct(typical)}.`, path: '/server/reliability' });
      if (toStaff) await this.staff.send({
        author: { name: 'Almanac · server alert' },
        title: 'Streams are dropping more than usual',
        description:
          `**${pct(rate)}** of streams in the last hour dropped (${current.dropped} of ${current.plays}). ` +
          `At this time of day it's usually about **${pct(typical)}**.\n\n` +
          'A dropped stream is one where Silo stopped hearing from the player mid-stream: a crash, a freeze or a lost connection.',
        fields: players.length
          ? [{ name: 'Most drops', value: players.map((p) => `${p.label}${p.platform ? ` (${p.platform})` : ''}: ${p.dropped} of ${p.plays}`).join('\n') }]
          : undefined,
        color: 0xd03b3b,
        footer: { text: 'Almanac' },
        timestamp: new Date(now).toISOString(),
      });
      this.staff.setState({ alerting: true, lastAlertAt: new Date(now).toISOString() });
      return 'alerted';
    }
    if (state.alerting && current.plays >= ALERT_MIN_PLAYS / 2 && rate <= typical * 1.3) {
      this.onAlert?.({ title: 'Streams are back to normal', body: `${pct(rate)} of streams in the last hour dropped, close to the usual ${pct(typical)}.`, path: '/server/reliability' });
      if (toStaff) await this.staff.send({
        author: { name: 'Almanac · server alert' },
        title: 'Streams are back to normal',
        description: `${pct(rate)} of streams in the last hour dropped, close to the usual ${pct(typical)}.`,
        color: 0x0ca30c,
        footer: { text: 'Almanac' },
        timestamp: new Date(now).toISOString(),
      });
      this.staff.setState({ alerting: false, lastAlertAt: state.lastAlertAt });
      return 'recovered';
    }
    return null;
  }

  // --- Internals -------------------------------------------------------------

  private counts(where: string, ...params: string[]): ReliabilityCounts {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS plays, COALESCE(SUM(${DROPPED}), 0) AS dropped, COALESCE(SUM(${QUICK}), 0) AS quick FROM plays WHERE ${MEASURED} AND ${where}`)
      .get(...params) as { plays: number; dropped: number; quick: number };
    return { plays: row.plays, dropped: row.dropped, quickStops: row.quick };
  }

  private byPlayer(fromIso: string, toIso: string): ReliabilityGroup[] {
    const rows = this.db
      .prepare(
        `SELECT client_name, device_platform, COUNT(*) AS plays, SUM(${DROPPED}) AS dropped, SUM(${QUICK}) AS quick
         FROM plays WHERE ${MEASURED} AND started_at >= ? AND started_at < ? GROUP BY client_name, device_platform`,
      )
      .all(fromIso, toIso) as { client_name: string | null; device_platform: string | null; plays: number; dropped: number; quick: number }[];
    const merged = new Map<string, ReliabilityGroup>();
    for (const r of rows) {
      const label = cleanClientName(r.client_name) ?? 'Unknown player';
      const platform = r.device_platform ? platformKey(r.device_platform) : null;
      const key = `${label}|${platform ?? ''}`;
      const g = merged.get(key) ?? { key, label, platform: r.device_platform, plays: 0, dropped: 0, quickStops: 0 };
      g.plays += r.plays;
      g.dropped += r.dropped;
      g.quickStops += r.quick;
      merged.set(key, g);
    }
    return [...merged.values()].sort((a, b) => b.plays - a.plays).slice(0, 15);
  }

  private byMethod(fromIso: string, toIso: string): ReliabilityGroup[] {
    const labels: Record<string, string> = { direct: 'Direct play', direct_stream: 'Direct stream', remux: 'Remux', transcode: 'Transcode' };
    const rows = this.db
      .prepare(
        `SELECT play_method, COUNT(*) AS plays, SUM(${DROPPED}) AS dropped, SUM(${QUICK}) AS quick
         FROM plays WHERE ${MEASURED} AND started_at >= ? AND started_at < ? GROUP BY play_method ORDER BY plays DESC`,
      )
      .all(fromIso, toIso) as { play_method: string | null; plays: number; dropped: number; quick: number }[];
    return rows.map((r) => ({
      key: r.play_method ?? 'unknown',
      label: labels[r.play_method ?? ''] ?? 'Unknown',
      platform: null,
      plays: r.plays,
      dropped: r.dropped,
      quickStops: r.quick,
    }));
  }

  private async siloSummary(hours: number): Promise<ReliabilityResponse['silo']> {
    const cached = this.siloCache.get(hours);
    let value = cached && Date.now() - cached.at < SILO_CACHE_MS ? cached.value : undefined;
    if (value === undefined) {
      value = await this.source.playbackActivity(hours).catch(() => null);
      this.siloCache.set(hours, { at: Date.now(), value });
    }
    const r = value?.reliability;
    if (!r) return null;
    return {
      sessionsStarted: r.sessions_started ?? 0,
      transcodeStarts: r.transcode_starts ?? 0,
      watchedToEnd: r.completion_rate ?? null,
      profiles: r.unique_profiles ?? 0,
    };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
