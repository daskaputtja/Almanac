import { useEffect, useMemo, useState } from 'react';
import type { HistoryFilterOptions } from '../../../shared/history';
import type { StatsRankBy } from '../../../shared/stats';
import {
  HeatmapCard,
  PERIODS,
  PeriodPicker,
  PlaysTimelineCard,
  RankPicker,
  SHORT_PLAY_SECONDS,
  StatTiles,
  useStats,
} from '../components/StatsSections';
import { TopList } from '../components/TopList';
import { platformLabel } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';

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
  const [users, setUsers] = useState<HistoryFilterOptions['users']>([]);
  const { data, view, loading, error } = useStats(filters.period, filters.user || null, filters.rankBy);

  const update = (changes: Partial<Filters>) => navigate(writeFilters({ ...filters, ...changes }), { replace: true });

  useEffect(() => {
    fetch('/api/history/filters')
      .then((r) => (r.ok ? (r.json() as Promise<HistoryFilterOptions>) : null))
      .then((o) => o && setUsers(o.users))
      .catch(() => {});
  }, []);

  const selectedUser = users.find((u) => u.id === filters.user);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Statistics</h1>
        <p className="text-sm text-ink-muted">
          {selectedUser ? `${selectedUser.name}’s viewing` : 'Everyone’s viewing'},{' '}
          {filters.period === 'all' ? 'all time' : `last ${PERIODS[filters.period]!.label}`}. Plays under {SHORT_PLAY_SECONDS}{' '}
          seconds aren’t counted.
        </p>
      </div>

      {/* Filters: one row, scoping everything below. */}
      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker value={filters.period} onChange={(period) => update({ period })} />
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
        {selectedUser && (
          <Link to={`/users/${encodeURIComponent(selectedUser.id)}`} className="text-sm text-harvest hover:underline">
            View {selectedUser.name}’s page
          </Link>
        )}
        <div className="sm:ml-auto">
          <RankPicker value={filters.rankBy} onChange={(rankBy) => update({ rankBy })} />
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          Couldn’t load statistics: {error}
        </div>
      )}

      {!data && loading && <p className="py-20 text-center text-sm text-ink-muted">Crunching the numbers…</p>}

      {data && view && (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <StatTiles data={data} view={view} singleUser={Boolean(filters.user)} />
          <PlaysTimelineCard view={view} />

          <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
            <HeatmapCard view={view} />
            <TopList
              title="Most active users"
              entries={data.top.users}
              rankBy={filters.rankBy}
              linkTo={(e) => `/users/${encodeURIComponent(e.key)}`}
            />
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
