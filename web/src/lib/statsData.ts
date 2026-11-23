import type { PlayMethod } from '../../../shared/activity';
import type { HourBucket } from '../../../shared/stats';

export const METHOD_ORDER: PlayMethod[] = ['direct', 'direct_stream', 'remux', 'transcode'];

export interface TimeBucket {
  start: Date;
  plays: number;
  watchedSeconds: number;
  byMethod: Record<PlayMethod, number>;
}

export type Granularity = 'day' | 'week';

function emptyMethods(): Record<PlayMethod, number> {
  return { direct: 0, direct_stream: 0, remux: 0, transcode: 0 };
}

/** Silo hours are UTC `YYYY-MM-DDTHH`; this is the instant they start. */
export function hourStart(hour: string): Date {
  return new Date(`${hour}:00:00Z`);
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Weeks start on Monday. */
export function startOfLocalWeek(date: Date): Date {
  const day = startOfLocalDay(date);
  const offset = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - offset);
}

function step(date: Date, granularity: Granularity): Date {
  const days = granularity === 'week' ? 7 : 1;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Turn UTC hour buckets into one bucket per local day (or week) from `from`
 * to `to`, including empty ones so gaps show as gaps.
 */
export function buildTimeline(hours: HourBucket[], from: Date, to: Date, granularity: Granularity): TimeBucket[] {
  const startOf = granularity === 'week' ? startOfLocalWeek : startOfLocalDay;
  const buckets: TimeBucket[] = [];
  const index = new Map<number, TimeBucket>();

  for (let d = startOf(from); d <= to; d = step(d, granularity)) {
    const bucket = { start: d, plays: 0, watchedSeconds: 0, byMethod: emptyMethods() };
    buckets.push(bucket);
    index.set(d.getTime(), bucket);
  }

  for (const [hour, plays, watched, direct, directStream, remux, transcode] of hours) {
    const bucket = index.get(startOf(hourStart(hour)).getTime());
    if (!bucket) continue;
    bucket.plays += plays;
    bucket.watchedSeconds += watched;
    bucket.byMethod.direct += direct;
    bucket.byMethod.direct_stream += directStream;
    bucket.byMethod.remux += remux;
    bucket.byMethod.transcode += transcode;
  }

  return buckets;
}

/** Plays by local weekday (Monday first) and hour: `grid[day][hour]`. */
export function buildWeekHourGrid(hours: HourBucket[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const [hour, plays] of hours) {
    const d = hourStart(hour);
    grid[(d.getDay() + 6) % 7]![d.getHours()]! += plays;
  }
  return grid;
}

/**
 * Round axis ticks from 0 to at least `value`: about `count` steps, each 1, 2
 * or 5 times a power of ten, so every label is a round number.
 */
export function niceTicks(value: number, count = 4): number[] {
  if (value <= 0) return [0, 1];
  const rough = value / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const stepSize = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const steps = Math.max(1, Math.ceil(value / stepSize));
  return Array.from({ length: steps + 1 }, (_, i) => i * stepSize);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 100) return `${Math.round(hours).toLocaleString()} h`;
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  return `${Math.round(seconds / 60)} min`;
}
