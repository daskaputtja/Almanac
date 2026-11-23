import { useEffect, useMemo, useState } from 'react';
import type { PlayMethod } from '../../../shared/activity';
import type { HistoryFilterOptions } from '../../../shared/history';
import type { StatsRankBy, StatsResult } from '../../../shared/stats';
import { type Bar, Legend, type Series, StackedBars } from '../components/charts/StackedBars';
import { WeekHourHeatmap } from '../components/charts/WeekHourHeatmap';
import { METHOD_STYLES } from '../components/MethodBadge';
import { TopList } from '../components/TopList';
import { PLAY_METHOD_LABELS, platformLabel } from '../lib/format';
import { navigate, useLocation } from '../lib/router';
import {
  METHOD_ORDER,
  type Granularity,
  buildTimeline,
  buildWeekHourGrid,
  formatCompact,
  formatHours,
} from '../lib/statsData';

const SHORT_PLAY_SECONDS = 30;

const PERIODS: Record<string, { label: string; days: number | null }> = {
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

interface Filters {
  period: string;
  user: string;
  rankBy: StatsRankBy;
}

function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const period = p.get('period') ?? '30d';
  return {
    period: PERIODS[period] ? period : '30d',
    user: p.get('user') ?? '',
    rankBy: p.get('rank') === 'watched' ? 'watched' : 'plays',
  };
}

function writeFilters(f: Filters): string {
  const p = new URLSearchParams();
  if (f.period !== '30d') p.set('period', f.period);
  if (f.user) p.set('user', f.user);
  if (f.rankBy !== 'plays') p.set('rank', f.rankBy);
  const q = p.toString();
  return `/stats${q ? `?${q}` : ''}`;
}

export function StatsPage() {
  const { search } = useLocation();
  const filters = useMemo(() => readFilters(search), [search]);
  const [data, setData] = useState<StatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<HistoryFilterOptions['users']>([]);
  const [showTable, setShowTable] = useState(false);

  const update = (changes: Partial<Filters>) => navigate(writeFilters({ ...filters, ...changes }), { replace: true });

  const days = PERIODS[filters.period]!.days;
  // Round "from" to the hour so repeated visits hit the server's cache.
  const from = useMemo(() => {
    if (!days) return null;
    const d = new Date(Date.now() - days * 86_400_000);
    d.setMinutes(0, 0, 0);
    return d;
  }, [days]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ minWatched: String(SHORT_PLAY_SECONDS), rankBy: filters.rankBy });
    if (from) params.set('from', from.toISOString());
    if (filters.user) params.set('user', filters.user);
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
  }, [from, filters.user, filters.rankBy]);

  useEffect(() => {
    fetch('/api/history/filters')
      .then((r) => (r.ok ? (r.json() as Promise<HistoryFilterOptions>) : null))
      .then((o) => o && setUsers(o.users))
      .catch(() => {});
  }, []);

  const view = useMemo(() => {
    if (!data) return null;
    const start = from ?? (data.firstPlayAt ? new Date(data.firstPlayAt) : new Date());
    const end = new Date();
    const spanDays = Math.max(1, (end.getTime() - start.getTime()) / 86_400_000);
    const granularity: Granularity = spanDays > 120 ? 'week' : 'day';
    const timeline = buildTimeline(data.hours, start, end, granularity);
    const bars: Bar<PlayMethod>[] = timeline.map((b) => ({
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

  const totals = data?.totals;
  const directShare = totals && totals.plays ? (totals.byMethod.direct / totals.plays) * 100 : null;
  const selectedUser = users.find((u) => u.id === filters.user);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Statistics</h1>
        <p className="text-sm text-ink-muted">
          {selectedUser ? `${selectedUser.name}’s viewing` : 'Everyone’s viewing'}, {filters.period === 'all' ? 'all time' : `last ${PERIODS[filters.period]!.label}`}.
          Plays under {SHORT_PLAY_SECONDS} seconds aren’t counted.
        </p>
      </div>

      {/* Filters: one row, scoping everything below. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex max-w-full overflow-x-auto rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Period">
          {Object.entries(PERIODS).map(([key, { label }]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filters.period === key}
              onClick={() => update({ period: key })}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
                filters.period === key ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="User"
          value={filters.user}
          onChange={(e) => update({ user: e.target.value })}
          className={`rounded-lg border bg-panel px-2 py-2 text-sm focus:border-harvest-dim focus:outline-none ${
            filters.user ? 'border-harvest-dim text-ink' : 'border-line text-ink-muted'
          }`}
        >
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2 text-sm text-ink-muted sm:ml-auto">
          Rank by
          <div className="flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Rank top lists by">
            {(['plays', 'watched'] as StatsRankBy[]).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={filters.rankBy === r}
                onClick={() => update({ rankBy: r })}
                className={`rounded-md px-3 py-1.5 transition-colors ${
                  filters.rankBy === r ? 'bg-panel-raised font-medium text-ink' : 'hover:text-ink'
                }`}
              >
                {r === 'plays' ? 'Plays' : 'Watch time'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          Couldn’t load statistics: {error}
        </div>
      )}

      {!data && loading && <p className="py-20 text-center text-sm text-ink-muted">Crunching the numbers…</p>}

      {data && totals && view && (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Plays" value={totals.plays.toLocaleString()} />
            <Stat label="Watch time" value={formatHours(totals.watchedSeconds)} detail={`${(totals.watchedSeconds / 86_400).toLocaleString(undefined, { maximumFractionDigits: 0 })} days`} />
            <Stat label="Average per day" value={formatCompact(totals.plays / view.spanDays)} detail="plays" />
            <Stat label={filters.user ? 'Titles' : 'Active users'} value={(filters.user ? totals.titles : totals.users).toLocaleString()} detail={filters.user ? 'shows and movies' : `${totals.titles.toLocaleString()} titles watched`} />
            <Stat label="Direct play" value={directShare == null ? '—' : `${directShare.toFixed(directShare > 99 ? 1 : 0)}%`} detail={`${totals.byMethod.transcode.toLocaleString()} transcodes`} />
          </div>

          <section className="rounded-xl border border-line bg-panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Plays per {view.granularity}, by playback method</h2>
              <Legend series={SERIES} />
            </div>
            {showTable ? (
              <TimelineTable timeline={view.timeline} granularity={view.granularity} />
            ) : (
              <StackedBars series={SERIES} bars={view.bars} label={`Plays per ${view.granularity}, by playback method`} formatValue={(v) => formatCompact(v)} />
            )}
            <button type="button" onClick={() => setShowTable(!showTable)} className="mt-2 text-xs text-harvest hover:underline">
              {showTable ? 'Show as chart' : 'Show as table'}
            </button>
          </section>

          <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
            <section className="rounded-xl border border-line bg-panel p-4">
              <h2 className="mb-3 text-sm font-semibold">When people press play</h2>
              <WeekHourHeatmap grid={view.grid} label="Plays by day of the week and hour" />
              <p className="mt-2 text-[11px] text-ink-faint">Times are in your time zone.</p>
            </section>
            <TopList title="Most active users" entries={data.top.users} rankBy={filters.rankBy} />
          </div>

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <TopList title="Top shows" entries={data.top.shows} rankBy={filters.rankBy} />
            <TopList title="Top movies" entries={data.top.movies} rankBy={filters.rankBy} />
            <TopList
              title="Top platforms"
              entries={data.top.platforms}
              rankBy={filters.rankBy}
              formatName={(e) => platformLabel(e.name) ?? e.name}
            />
            <TopList title="Top players" entries={data.top.players} rankBy={filters.rankBy} />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-xs font-medium uppercase tracking-wider text-ink-faint">{label}</h2>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="text-sm text-ink-muted">{detail}</p>}
    </section>
  );
}

function TimelineTable({ timeline, granularity }: { timeline: ReturnType<typeof buildTimeline>; granularity: Granularity }) {
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
                {b.start.toLocaleDateString(undefined, { weekday: granularity === 'day' ? 'short' : undefined, day: 'numeric', month: 'short', year: 'numeric' })}
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
