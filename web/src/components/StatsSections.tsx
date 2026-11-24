import { useEffect, useMemo, useState } from 'react';
import type { PlayMethod } from '../../../shared/activity';
import type { StatsRankBy, StatsResult } from '../../../shared/stats';
import { PLAY_METHOD_LABELS } from '../lib/format';
import {
  METHOD_ORDER,
  type Granularity,
  type TimeBucket,
  buildTimeline,
  buildWeekHourGrid,
  formatCompact,
  formatHours,
} from '../lib/statsData';
import { type Bar, Legend, type Series, StackedBars } from './charts/StackedBars';
import { WeekHourHeatmap } from './charts/WeekHourHeatmap';
import { METHOD_STYLES } from './MethodBadge';

/** Plays shorter than this are left out everywhere, like on the History page. */
export const SHORT_PLAY_SECONDS = 30;

export const PERIODS: Record<string, { label: string; days: number | null }> = {
  '7d': { label: '7 days', days: 7 },
  '30d': { label: '30 days', days: 30 },
  '90d': { label: '90 days', days: 90 },
  '365d': { label: '1 year', days: 365 },
  all: { label: 'All time', days: null },
};

const SERIES: Series<PlayMethod>[] = METHOD_ORDER.map((m) => ({
  key: m,
  label: PLAY_METHOD_LABELS[m],
  color: METHOD_STYLES[m].color,
}));

export interface StatsView {
  bars: Bar<PlayMethod>[];
  granularity: Granularity;
  spanDays: number;
  grid: number[][];
  timeline: TimeBucket[];
}

/** Fetch statistics for a period (and optionally one user), plus the chart data built from them. */
export function useStats(period: string, userId: string | null, rankBy: StatsRankBy) {
  const [data, setData] = useState<StatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const days = PERIODS[period]?.days ?? 30;
  // Round "from" to the hour so repeated visits hit the server's cache.
  const from = useMemo(() => {
    if (!days) return null;
    const d = new Date(Date.now() - days * 86_400_000);
    d.setMinutes(0, 0, 0);
    return d;
  }, [days]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ minWatched: String(SHORT_PLAY_SECONDS), rankBy });
    if (from) params.set('from', from.toISOString());
    if (userId) params.set('user', userId);
    setLoading(true);
    fetch(`/api/stats?${params}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Almanac returned ${res.status}`);
        return res.json() as Promise<StatsResult>;
      })
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [from, userId, rankBy]);

  const view = useMemo((): StatsView | null => {
    if (!data) return null;
    const start = from ?? (data.firstPlayAt ? new Date(data.firstPlayAt) : new Date());
    const end = new Date();
    const spanDays = Math.max(1, (end.getTime() - start.getTime()) / 86_400_000);
    const granularity: Granularity = spanDays > 120 ? 'week' : 'day';
    const timeline = buildTimeline(data.hours, start, end, granularity);
    const bars = timeline.map((b) => ({
      id: b.start.toISOString(),
      label: b.start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      title:
        granularity === 'week'
          ? `Week of ${b.start.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`
          : b.start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
      values: b.byMethod,
    }));
    return { bars, granularity, spanDays, grid: buildWeekHourGrid(data.hours), timeline };
  }, [data, from]);

  return { data, view, loading, error };
}

export function PeriodPicker({ value, onChange }: { value: string; onChange: (period: string) => void }) {
  return (
    <div className="relative flex max-w-full overflow-x-auto rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Period">
      {Object.entries(PERIODS).map(([key, { label }]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
            value === key ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function RankPicker({ value, onChange }: { value: StatsRankBy; onChange: (rank: StatsRankBy) => void }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-muted">
      Rank by
      <div className="flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Rank top lists by">
        {(['plays', 'watched'] as StatsRankBy[]).map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={value === r}
            onClick={() => onChange(r)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 transition-colors ${
              value === r ? 'bg-panel-raised font-medium text-ink' : 'hover:text-ink'
            }`}
          >
            {r === 'plays' ? 'Plays' : 'Watch time'}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-xs font-medium uppercase tracking-wider text-ink-faint">{label}</h2>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="text-sm text-ink-muted">{detail}</p>}
    </section>
  );
}

/** The five headline numbers. For one user, "Active users" becomes "Titles". */
export function StatTiles({ data, view, singleUser }: { data: StatsResult; view: StatsView; singleUser: boolean }) {
  const { totals } = data;
  const directShare = totals.plays ? (totals.byMethod.direct / totals.plays) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <Stat label="Plays" value={totals.plays.toLocaleString()} />
      <Stat
        label="Watch time"
        value={formatHours(totals.watchedSeconds)}
        detail={`${(totals.watchedSeconds / 86_400).toLocaleString(undefined, { maximumFractionDigits: 1 })} days`}
      />
      <Stat label="Average per day" value={formatCompact(totals.plays / view.spanDays)} detail="plays" />
      <Stat
        label={singleUser ? 'Titles' : 'Active users'}
        value={(singleUser ? totals.titles : totals.users).toLocaleString()}
        detail={singleUser ? 'shows and movies' : `${totals.titles.toLocaleString()} titles watched`}
      />
      <Stat
        label="Direct play"
        value={directShare == null ? '—' : `${directShare.toFixed(directShare > 99 ? 1 : 0)}%`}
        detail={`${totals.byMethod.transcode.toLocaleString()} transcodes`}
      />
    </div>
  );
}

export function PlaysTimelineCard({ view }: { view: StatsView }) {
  const [showTable, setShowTable] = useState(false);
  const title = `Plays per ${view.granularity}, by playback method`;
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Legend series={SERIES} />
      </div>
      {showTable ? (
        <TimelineTable timeline={view.timeline} granularity={view.granularity} />
      ) : (
        <StackedBars series={SERIES} bars={view.bars} label={title} formatValue={(v) => formatCompact(v)} />
      )}
      <button type="button" onClick={() => setShowTable(!showTable)} className="mt-2 text-xs text-accent hover:underline">
        {showTable ? 'Show as chart' : 'Show as table'}
      </button>
    </section>
  );
}

export function HeatmapCard({
  view,
  title = 'When people press play',
  className = '',
}: {
  view: StatsView;
  title?: string;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-line bg-panel p-4 ${className}`}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      <WeekHourHeatmap grid={view.grid} label="Plays by day of the week and hour" />
      <p className="mt-2 text-[11px] text-ink-faint">Times are in your time zone.</p>
    </section>
  );
}

function TimelineTable({ timeline, granularity }: { timeline: TimeBucket[]; granularity: Granularity }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-line">
      <table className="w-full text-right text-sm tabular-nums">
        <thead className="sticky top-0 bg-panel-raised text-xs text-ink-faint">
          <tr>
            <th className="px-3 py-2 text-left font-medium">{granularity === 'week' ? 'Week of' : 'Day'}</th>
            {METHOD_ORDER.map((m) => (
              <th key={m} className="px-3 py-2 font-medium">
                {PLAY_METHOD_LABELS[m]}
              </th>
            ))}
            <th className="px-3 py-2 font-medium">Total</th>
            <th className="px-3 py-2 font-medium">Watch time</th>
          </tr>
        </thead>
        <tbody>
          {[...timeline].reverse().map((b) => (
            <tr key={b.start.toISOString()} className="border-t border-line/60">
              <td className="px-3 py-1.5 text-left text-ink-muted">
                {b.start.toLocaleDateString(undefined, {
                  weekday: granularity === 'day' ? 'short' : undefined,
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </td>
              {METHOD_ORDER.map((m) => (
                <td key={m} className="px-3 py-1.5">
                  {b.byMethod[m].toLocaleString()}
                </td>
              ))}
              <td className="px-3 py-1.5 font-medium">{b.plays.toLocaleString()}</td>
              <td className="px-3 py-1.5 text-ink-muted">{formatHours(b.watchedSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
