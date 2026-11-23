import { useEffect, useMemo, useState } from 'react';
import type { UserSummary, UsersResponse } from '../../../shared/users';
import { Avatar, RoleBadges } from '../components/Avatar';
import { formatWhen, platformLabel } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { formatHours } from '../lib/statsData';

type SortKey = 'lastPlayed' | 'name' | 'plays30' | 'plays' | 'watched' | 'direct';
type Show = 'all' | 'active' | 'inactive' | 'disabled';

const SORTS: Record<SortKey, (a: UserSummary, b: UserSummary) => number> = {
  lastPlayed: (a, b) => (b.lastPlayedAt ?? '').localeCompare(a.lastPlayedAt ?? ''),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  plays30: (a, b) => b.plays30Days - a.plays30Days,
  plays: (a, b) => b.plays - a.plays,
  watched: (a, b) => b.watchedSeconds - a.watchedSeconds,
  direct: (a, b) => (b.directPlayPercent ?? -1) - (a.directPlayPercent ?? -1),
};

const SHOW_LABELS: Record<Show, string> = {
  all: 'Everyone',
  active: 'Watched in last 30 days',
  inactive: 'Not watched in 30 days',
  disabled: 'Disabled or deleted',
};

const PAGE = 100;

export function UsersPage() {
  const { search } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const sort = (params.get('sort') as SortKey) in SORTS ? (params.get('sort') as SortKey) : 'lastPlayed';
  const reverse = params.get('dir') === 'asc';
  const show = (params.get('show') as Show) in SHOW_LABELS ? (params.get('show') as Show) : 'all';
  const [query, setQuery] = useState(params.get('search') ?? '');
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE);

  const setParam = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const q = next.toString();
    navigate(`/users${q ? `?${q}` : ''}`, { replace: true });
  };

  useEffect(() => {
    const id = setTimeout(() => setParam({ search: query.trim() || null }), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    fetch('/api/users')
      .then((r) => {
        if (!r.ok) throw new Error(`Almanac returned ${r.status}`);
        return r.json() as Promise<UsersResponse>;
      })
      .then((d) => setUsers(d.users))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = (params.get('search') ?? '').toLowerCase();
    const list = users.filter((u) => {
      if (q && !u.name.toLowerCase().includes(q)) return false;
      if (show === 'active') return u.plays30Days > 0;
      if (show === 'inactive') return u.plays30Days === 0 && u.inSilo && u.enabled !== false;
      if (show === 'disabled') return !u.inSilo || u.enabled === false;
      return true;
    });
    list.sort(SORTS[sort]);
    if (reverse) list.reverse();
    return list;
  }, [users, params, show, sort, reverse]);

  useEffect(() => setVisible(PAGE), [search]);

  const sortBy = (key: SortKey) => setParam({ sort: key === 'lastPlayed' ? null : key, dir: sort === key && !reverse ? 'asc' : null });
  const active = users?.filter((u) => u.plays30Days > 0).length ?? 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-ink-muted">
          {users ? `${users.length.toLocaleString()} accounts, ${active.toLocaleString()} watched something in the last 30 days.` : ' '}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search users"
          aria-label="Search users"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm placeholder:text-ink-faint focus:border-harvest-dim focus:outline-none sm:w-72"
        />
        <select
          aria-label="Show"
          value={show}
          onChange={(e) => setParam({ show: e.target.value === 'all' ? null : e.target.value })}
          className={`rounded-lg border bg-panel px-2 py-2 text-sm focus:border-harvest-dim focus:outline-none ${
            show !== 'all' ? 'border-harvest-dim text-ink' : 'border-line text-ink-muted'
          }`}
        >
          {Object.entries(SHOW_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          Couldn’t load users: {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wider text-ink-faint">
              <tr>
                <Th label="User" sortKey="name" sort={sort} reverse={reverse} onSort={sortBy} />
                <Th label="Last watched" sortKey="lastPlayed" sort={sort} reverse={reverse} onSort={sortBy} />
                <Th label="Plays (30 days)" sortKey="plays30" sort={sort} reverse={reverse} onSort={sortBy} align="right" />
                <Th label="Total plays" sortKey="plays" sort={sort} reverse={reverse} onSort={sortBy} align="right" />
                <Th label="Watch time" sortKey="watched" sort={sort} reverse={reverse} onSort={sortBy} align="right" />
                <th className="px-3 py-2.5 font-medium">Top platform</th>
                <Th label="Direct play" sortKey="direct" sort={sort} reverse={reverse} onSort={sortBy} align="right" />
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, visible).map((u) => (
                <tr
                  key={u.id}
                  className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel-raised/60"
                  onClick={() => navigate(`/users/${encodeURIComponent(u.id)}`)}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.name} size="sm" />
                      <Link
                        to={`/users/${encodeURIComponent(u.id)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-medium text-harvest hover:underline"
                      >
                        {u.name}
                      </Link>
                      <RoleBadges role={u.role} isOwner={u.isOwner} enabled={u.enabled} inSilo={u.inSilo} />
                    </div>
                  </td>
                  <td className="max-w-[18rem] px-3 py-2.5">
                    {u.lastPlayed && u.lastPlayedAt ? (
                      <>
                        <div className="truncate">{u.lastPlayed.seriesTitle ?? u.lastPlayed.title}</div>
                        <div className="text-xs text-ink-faint">{formatWhen(u.lastPlayedAt)}</div>
                      </>
                    ) : (
                      <span className="text-ink-faint">Never</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{u.plays30Days ? u.plays30Days.toLocaleString() : <span className="text-ink-faint">0</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{u.plays.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {u.watchedSeconds > 0 ? formatHours(u.watchedSeconds) : <span className="text-ink-faint">{u.plays ? 'not measured' : '—'}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">{platformLabel(u.topPlatform) ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{u.directPlayPercent == null ? '—' : `${Math.round(u.directPlayPercent)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!users && !error && <p className="px-4 py-16 text-center text-sm text-ink-muted">Loading users…</p>}
        {users && filtered.length === 0 && <p className="px-4 py-16 text-center text-sm text-ink-muted">No users match.</p>}
      </div>

      {filtered.length > visible && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => setVisible(visible + PAGE)}
            className="rounded-lg border border-line bg-panel px-4 py-2 text-sm hover:border-harvest-dim"
          >
            Show more ({(filtered.length - visible).toLocaleString()} left)
          </button>
        </div>
      )}
    </div>
  );
}

function Th({
  label,
  sortKey,
  sort,
  reverse,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  sort: SortKey;
  reverse: boolean;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === sortKey;
  return (
    <th className={`px-3 py-2.5 font-medium ${align === 'right' ? 'text-right' : ''}`} aria-sort={active ? (reverse ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sortKey)} className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink ${active ? 'text-ink' : ''}`}>
        {label}
        <span aria-hidden="true" className={active ? 'text-harvest' : 'invisible'}>
          {reverse && active ? '↑' : '↓'}
        </span>
      </button>
    </th>
  );
}
