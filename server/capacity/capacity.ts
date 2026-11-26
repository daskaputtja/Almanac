import {
  CAPACITY_METRICS,
  type CapacityLimits,
  type CapacityMetric,
  type CapacityMetricReport,
  type CapacityReport,
  type CapacityStatus,
} from '../../shared/capacity.js';
import type { Database } from '../db/database.js';
import { SettingsStore } from '../db/settings.js';
import type { StaffAlerts } from '../notify/staff.js';

const DAY_MS = 86_400_000;
/** History used for the trend: long enough to see growth, short enough to follow changes. */
const HISTORY_DAYS = 56;
/** Fewer days than this and the trend is guesswork. */
export const MINIMUM_DAYS = 21;
/** A day needs this many hours of samples to count (gaps make the peak too low). */
const MIN_HOURS_PER_DAY = 18;
const FORECAST_DAYS = 365;
const CHECK_EVERY_MS = 6 * 3_600_000;
/** Don't repeat the same alert for a metric more often than this. */
const REALERT_MS = 7 * DAY_MS;

const LIMITS_KEY = 'capacity.limits';
const STATE_KEY = 'capacity.state';

const RANK: Record<CapacityStatus, number> = { unknown: 0, ok: 0, watch: 1, tight: 2 };

type AlertState = Partial<Record<CapacityMetric, { status: CapacityStatus; alertedAt: string | null }>>;

export class CapacityError extends Error {}

/**
 * Watches evening peaks (streams, upload bandwidth, transcodes) from the
 * load history Almanac keeps, fits a trend, and says when busy evenings will
 * reach the limits the owner sets.
 */
export class CapacityService {
  private readonly settings: SettingsStore;
  private timer: NodeJS.Timeout | null = null;
  /** Also told about alerts (for push notifications to the phone app). */
  onAlert: ((message: { title: string; body: string; path?: string }) => void) | null = null;

  constructor(
    private readonly db: Database,
    private readonly staff: StaffAlerts | null = null,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.settings = new SettingsStore(db);
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.checkAlerts().catch((err) => this.log(`Capacity check: ${err instanceof Error ? err.message : String(err)}`));
      this.timer = setTimeout(tick, CHECK_EVERY_MS);
    };
    this.timer = setTimeout(tick, 5 * 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  limits(): CapacityLimits {
    return { streams: null, mbps: null, transcodes: null, ...(this.settings.get<CapacityLimits>(LIMITS_KEY)?.value ?? {}) };
  }

  setLimits(input: Partial<Record<CapacityMetric, unknown>>, by: string): CapacityReport {
    const next = this.limits();
    for (const { key } of CAPACITY_METRICS) {
      if (!(key in input)) continue;
      const raw = input[key];
      if (raw === null || raw === '' || raw === undefined) {
        next[key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new CapacityError('Limits have to be positive numbers (or left empty).');
      next[key] = Math.round(n * 10) / 10;
    }
    this.settings.set(LIMITS_KEY, next, by);
    // New limits: let the next check alert afresh.
    this.settings.delete(STATE_KEY);
    return this.report();
  }

  report(now = Date.now()): CapacityReport {
    const limits = this.limits();
    const stored = this.settings.get<CapacityLimits>(LIMITS_KEY);
    const days = this.dailyPeaks(now);
    return {
      historyDays: days.length,
      minimumDays: MINIMUM_DAYS,
      metrics: CAPACITY_METRICS.map(({ key }) => analyse(key, days, limits[key], now)),
      limits,
      updatedBy: stored?.updatedBy ?? null,
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  /** Tell staff (Discord and the phone app) when a metric gets closer to its limit. */
  async checkAlerts(now = Date.now()): Promise<CapacityMetricReport[]> {
    const toStaff = Boolean(this.staff?.wants('capacity'));
    if (!toStaff && !this.onAlert) return [];
    const report = this.report(now);
    const state: AlertState = this.settings.get<AlertState>(STATE_KEY)?.value ?? {};
    const sent: CapacityMetricReport[] = [];

    for (const m of report.metrics) {
      if (m.status === 'unknown') continue;
      const before = state[m.metric];
      const worse = RANK[m.status] > RANK[before?.status ?? 'ok'];
      const recent = before?.alertedAt && now - Date.parse(before.alertedAt) < REALERT_MS && RANK[before.status] >= RANK[m.status];
      if (worse && !recent) {
        const { title, body } = alertText(m);
        this.onAlert?.({ title, body, path: '/server/capacity' });
        if (toStaff && this.staff) {
          const base = this.staff.baseUrl();
          await this.staff.send({
            author: { name: 'Almanac · capacity' },
            title,
            url: base ? `${base}/server/capacity` : undefined,
            description: body,
            color: m.status === 'tight' ? 0xd03b3b : 0xfab219,
            footer: { text: 'Almanac' },
            timestamp: new Date(now).toISOString(),
          });
        }
        state[m.metric] = { status: m.status, alertedAt: new Date(now).toISOString() };
        sent.push(m);
      } else if (!before || RANK[m.status] < RANK[before.status]) {
        // Better (or first look): remember it quietly, keeping when we last alerted.
        state[m.metric] = { status: m.status, alertedAt: before?.alertedAt ?? null };
      }
    }
    this.settings.set(STATE_KEY, state, null);
    return sent;
  }

  // --- Internals -------------------------------------------------------------

  /**
   * One peak per day for each metric. Samples are averaged per hour first, so
   * older hourly history and newer 5-minute samples measure the same thing.
   * Days start at the quietest hour, so a late evening isn't split in two.
   */
  private dailyPeaks(now: number): DayPeak[] {
    const from = Math.floor((now - (HISTORY_DAYS + 2) * DAY_MS) / 1000);
    const hours = this.db
      .prepare(
        `SELECT (t / 3600) * 3600 AS hour, AVG(streams) AS s, AVG(COALESCE(egress_kbps, 0)) AS e, AVG(COALESCE(transcode, 0)) AS tr
         FROM load_points WHERE t >= ? GROUP BY hour ORDER BY hour`,
      )
      .all(from) as { hour: number; s: number; e: number; tr: number }[];
    if (!hours.length) return [];

    // The quietest hour of the day, over the last four weeks.
    const byHour = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
    for (const h of hours) {
      if (h.hour * 1000 < now - 28 * DAY_MS) continue;
      const slot = byHour[new Date(h.hour * 1000).getUTCHours()]!;
      slot.sum += h.s;
      slot.n++;
    }
    let quiet = 0;
    let quietest = Infinity;
    byHour.forEach((slot, hour) => {
      const avg = slot.n ? slot.sum / slot.n : Infinity;
      if (avg < quietest) {
        quietest = avg;
        quiet = hour;
      }
    });
    const offset = quiet * 3_600_000;

    const days = new Map<number, DayPeak & { hours: number }>();
    for (const h of hours) {
      const start = Math.floor((h.hour * 1000 - offset) / DAY_MS) * DAY_MS + offset;
      const d = days.get(start) ?? { start, streams: 0, mbps: 0, transcodes: 0, hours: 0 };
      d.streams = Math.max(d.streams, h.s);
      d.mbps = Math.max(d.mbps, h.e / 1000);
      d.transcodes = Math.max(d.transcodes, h.tr);
      d.hours++;
      days.set(start, d);
    }
    return [...days.values()]
      .filter((d) => d.start + DAY_MS <= now && d.start >= now - (HISTORY_DAYS + 1) * DAY_MS && d.hours >= MIN_HOURS_PER_DAY)
      .sort((a, b) => a.start - b.start)
      .map(({ start, streams, mbps, transcodes }) => ({ start, streams, mbps, transcodes }));
  }
}

interface DayPeak {
  start: number;
  streams: number;
  mbps: number;
  transcodes: number;
}

export function analyse(metric: CapacityMetric, days: DayPeak[], limit: number | null, now: number): CapacityMetricReport {
  const round = (n: number) => Math.round(n * 10) / 10;
  const points: [number, number][] = days.map((d) => [d.start, round(d[metric])]);
  const lastWeek = points.filter(([t]) => t >= now - 8 * DAY_MS);
  const busiestPoint = lastWeek.reduce<[number, number] | null>((best, p) => (!best || p[1] > best[1] ? p : best), null);
  const busiest = busiestPoint ? { value: busiestPoint[1], on: new Date(busiestPoint[0]).toISOString() } : null;
  const used = limit && busiest ? busiest.value / limit : null;

  let typical: number | null = null;
  let growthPerMonth: number | null = null;
  let fullBy: string | null = null;
  let trend: [number, number][] = [];
  let soonest = Infinity;

  if (points.length >= MINIMUM_DAYS) {
    const xs = points.map(([t]) => (t - now) / DAY_MS);
    const ys = points.map(([, v]) => v);
    const { slope, intercept } = theilSen(xs, ys);
    const at = (x: number) => intercept + slope * x;
    typical = round(Math.max(0, at(0)));
    growthPerMonth = typical > 0 ? Math.round(((slope * 30) / typical) * 1000) / 1000 : null;
    // Busy evenings sit above the trend; follow the busiest tenth of them.
    const busyMargin = quantile(ys.map((y, i) => y - at(xs[i]!)), 0.9);
    if (limit) {
      if (at(0) + busyMargin >= limit) soonest = 0;
      else if (slope > 0) soonest = (limit - busyMargin - intercept) / slope;
      if (soonest <= FORECAST_DAYS) fullBy = new Date(now + Math.max(0, soonest) * DAY_MS).toISOString();
    }
    const end = Math.min(FORECAST_DAYS, Math.max(30, Number.isFinite(soonest) ? Math.ceil(soonest) + 7 : 30));
    trend = [xs[0]!, 0, end].map((x): [number, number] => [now + x * DAY_MS, round(Math.max(0, at(x)))]);
  }

  let status: CapacityStatus = 'unknown';
  if (limit && used !== null) {
    if (used >= 0.95 || soonest <= 30) status = 'tight';
    else if (used >= 0.8 || soonest <= 90) status = 'watch';
    else status = 'ok';
  }
  return { metric, busiest, typical, growthPerMonth, limit, used, fullBy, status, days: points, trend };
}

/** A straight line through the points that ignores the odd strange day: the median of all pairwise slopes. */
export function theilSen(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[j] !== xs[i]) slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
    }
  }
  const slope = slopes.length ? quantile(slopes, 0.5) : 0;
  const intercept = quantile(
    ys.map((y, i) => y - slope * xs[i]!),
    0.5,
  );
  return { slope, intercept };
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function alertText(m: CapacityMetricReport): { title: string; body: string } {
  const info = CAPACITY_METRICS.find((c) => c.key === m.metric)!;
  const fmt = (n: number) => `${Math.round(n).toLocaleString('en-US')} ${info.unit}`;
  const lines: string[] = [];
  if (m.busiest && m.limit) {
    lines.push(`The busiest evening this week reached ${fmt(m.busiest.value)}, ${Math.round((m.used ?? 0) * 100)}% of the ${fmt(m.limit)} you set.`);
  }
  if (m.growthPerMonth !== null && Math.abs(m.growthPerMonth) >= 0.01) {
    lines.push(`Evening peaks are ${m.growthPerMonth > 0 ? 'growing' : 'shrinking'} by about ${Math.round(Math.abs(m.growthPerMonth) * 100)}% a month.`);
  }
  if (m.fullBy) {
    const when = new Date(m.fullBy);
    lines.push(
      when.getTime() <= Date.now() + DAY_MS
        ? 'Busy evenings are already at the limit.'
        : `At this rate, busy evenings reach the limit around ${when.toLocaleDateString('en-US', { day: 'numeric', month: 'long', timeZone: 'UTC' })}.`,
    );
  }
  return {
    title: `${m.status === 'tight' ? 'Nearly out of room' : 'Getting busier'}: ${info.label.toLowerCase()}`,
    body: lines.join(' '),
  };
}
