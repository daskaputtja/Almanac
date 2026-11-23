import { Fragment, useEffect, useMemo, useState } from 'react';
import type { PlayMethod } from '../../../shared/activity';
import type {
  HistoryEntry,
  HistoryFilterOptions,
  HistoryPage as HistoryPageData,
  HistorySort,
  HistorySyncStatus,
} from '../../../shared/history';
import { MethodBadge } from '../components/MethodBadge';
import {
  PLAY_METHOD_LABELS,
  codecLabel,
  endReasonLabel,
  episodeCode,
  formatClock,
  formatDuration,
  formatFullDate,
  formatWhen,
  platformLabel,
} from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';

const PAGE_SIZE = 50;
const SHORT_PLAY_SECONDS = 30;

const PERIODS: Record<string, { label: string; days: number | null }> = {
  all: { label: 'All time', days: null },
  '1d': { label: 'Last 24 hours', days: 1 },
  '7d': { label: 'Last 7 days', days: 7 },
  '30d': { label: 'Last 30 days', days: 30 },
  '90d': { label: 'Last 90 days', days: 90 },
  '365d': { label: 'Last year', days: 365 },
};

const METHODS: PlayMethod[] = ['direct', 'direct_stream', 'remux', 'transcode'];

/** Filters live in the URL, so a filtered view can be bookmarked or shared. */
interface Filters {
  search: string;
  user: string;
  type: string;
  method: string;
  platform: string;
  period: string;
  showShort: boolean;
  sort: HistorySort;
  direction: 'asc' | 'desc';
  page: number;
}

function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const sort = p.get('sort') as HistorySort | null;
  return {
    search: p.get('search') ?? '',
    user: p.get('user') ?? '',
    type: p.get('type') ?? '',
    method: p.get('method') ?? '',
    platform: p.get('platform') ?? '',
    period: p.get('period') && PERIODS[p.get('period')!] ? p.get('period')! : 'all',
    showShort: p.get('short') === '1',
    sort: sort && ['ended', 'user', 'title', 'watched'].includes(sort) ? sort : 'ended',
    direction: p.get('direction') === 'asc' ? 'asc' : 'desc',
    page: Math.max(1, Number(p.get('page')) || 1),
  };
}

function writeFilters(f: Filters): string {
  const p = new URLSearchParams();
  if (f.search) p.set('search', f.search);
  if (f.user) p.set('user', f.user);
  if (f.type) p.set('type', f.type);
  if (f.method) p.set('method', f.method);
  if (f.platform) p.set('platform', f.platform);
  if (f.period !== 'all') p.set('period', f.period);
  if (f.showShort) p.set('short', '1');
  if (f.sort !== 'ended') p.set('sort', f.sort);
  if (f.direction !== 'desc') p.set('direction', f.direction);
  if (f.page > 1) p.set('page', String(f.page));
  const query = p.toString();
  return `/history${query ? `?${query}` : ''}`;
}

/** The API query for a set of filters. */
function apiQuery(f: Filters): string {
  const p = new URLSearchParams({ page: String(f.page), pageSize: String(PAGE_SIZE), sort: f.sort, direction: f.direction });
  if (f.search) p.set('search', f.search);
  if (f.user) p.set('user', f.user);
  if (f.type) p.set('type', f.type);
  if (f.method) p.set('method', f.method);
  if (f.platform) p.set('platform', f.platform);
  if (!f.showShort) p.set('minWatched', String(SHORT_PLAY_SECONDS));
  const days = PERIODS[f.period]?.days;
  if (days) p.set('from', new Date(Date.now() - days * 86_400_000).toISOString());
  return p.toString();
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Almanac returned ${res.status}`);
  return (await res.json()) as T;
}

export function HistoryPage() {
  const { search } = useLocation();
  const filters = useMemo(() => readFilters(search), [search]);
  const [data, setData] = useState<HistoryPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<HistoryFilterOptions>({ users: [], platforms: [] });
  const [status, setStatus] = useState<HistorySyncStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [searchText, setSearchText] = useState(filters.search);

  const update = (changes: Partial<Filters>, { push = false } = {}) => {
    // Any change other than paging goes back to page 1.
    const next = { ...filters, page: 1, ...changes };
    navigate(writeFilters(next), { replace: !push });
  };

  // Debounce typing in the search box.
  useEffect(() => {
    if (searchText === filters.search) return;
    const id = setTimeout(() => update({ search: searchText.trim() }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  // Fetch the current page of history.
  const query = apiQuery(filters);
  const refreshKey = status?.newestPlayAt;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getJson<HistoryPageData>(`/api/history?${query}`, controller.signal)
      .then((page) => {
        setData(page);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Refetch when new plays arrive, but only automatically on the first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filters.page === 1 ? refreshKey : null]);

  // Import progress and filter choices. Poll faster while the first import is running.
  const importing = status ? !status.import.done : true;
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getJson<HistorySyncStatus>('/api/history/status').then((s) => !cancelled && setStatus(s)).catch(() => {});
      getJson<HistoryFilterOptions>('/api/history/filters').then((o) => !cancelled && setOptions(o)).catch(() => {});
    };
    load();
    const id = setInterval(load, importing ? 10_000 : 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [importing]);

  const sortBy = (sort: HistorySort) => {
    const direction = filters.sort === sort && filters.direction === 'desc' ? 'asc' : 'desc';
    update({ sort, direction });
  };

  const activeFilterCount =
    [filters.search, filters.user, filters.type, filters.method, filters.platform].filter(Boolean).length +
    (filters.period !== 'all' ? 1 : 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">History</h1>
          <SyncLine status={status} />
        </div>
      </div>

      {status && !status.import.done && (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-harvest-dim/60 bg-harvest/10 px-4 py-3 text-sm">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-harvest border-t-transparent" aria-hidden="true" />
          <span>
            Importing your play history from Silo: <strong className="tabular-nums">{status.import.imported.toLocaleString()}</strong> plays
            so far
            {status.oldestPlayAt && <> (back to {new Date(status.oldestPlayAt).toLocaleDateString(undefined, { dateStyle: 'medium' })})</>}.
            Older plays will appear as the import continues.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 lg:flex-row lg:flex-wrap lg:items-center">
        <input
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search title, user, player or IP"
          aria-label="Search history"
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-harvest-dim focus:outline-none lg:w-72"
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-wrap">
          <Select label="User" value={filters.user} onChange={(user) => update({ user })}>
            <option value="">All users</option>
            {options.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.plays.toLocaleString()})
              </option>
            ))}
          </Select>
          <Select label="Type" value={filters.type} onChange={(type) => update({ type })}>
            <option value="">Movies and episodes</option>
            <option value="movie">Movies</option>
            <option value="episode">Episodes</option>
          </Select>
          <Select label="Playback" value={filters.method} onChange={(method) => update({ method })}>
            <option value="">Any playback</option>
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {PLAY_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
          <Select label="Platform" value={filters.platform} onChange={(platform) => update({ platform })}>
            <option value="">All platforms</option>
            {options.platforms.map((p) => (
              <option key={p.value} value={p.value}>
                {platformLabel(p.value)}
              </option>
            ))}
          </Select>
          <Select label="Period" value={filters.period} active={filters.period !== 'all'} onChange={(period) => update({ period })}>
            {Object.entries(PERIODS).map(([key, { label }]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-muted lg:ml-auto">
          <input
            type="checkbox"
            checked={filters.showShort}
            onChange={(e) => update({ showShort: e.target.checked })}
            className="h-4 w-4 accent-harvest"
          />
          Show plays under {SHORT_PLAY_SECONDS}s
        </label>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => {
              setSearchText('');
              navigate('/history', { replace: true });
            }}
            className="text-sm text-harvest hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          Couldn’t load history: {error}
        </div>
      )}

      <div className={`overflow-hidden rounded-xl border border-line bg-panel transition-opacity ${loading && data ? 'opacity-60' : ''}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wider text-ink-faint">
              <tr>
                <SortHeader label="When" sort="ended" filters={filters} onSort={sortBy} />
                <SortHeader label="User" sort="user" filters={filters} onSort={sortBy} />
                <SortHeader label="Title" sort="title" filters={filters} onSort={sortBy} />
                <th className="px-3 py-2.5 font-medium">Player</th>
                <th className="px-3 py-2.5 font-medium">Playback</th>
                <SortHeader label="Watched" sort="watched" filters={filters} onSort={sortBy} align="right" />
                <th className="w-40 px-3 py-2.5 font-medium">Progress</th>
                <th className="w-8 px-2 py-2.5">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((entry) => (
                <Fragment key={entry.id}>
                  <HistoryRow
                    entry={entry}
                    expanded={expanded === entry.id}
                    onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  />
                  {expanded === entry.id && <HistoryDetails entry={entry} />}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {!data && loading && <p className="px-4 py-16 text-center text-sm text-ink-muted">Loading history…</p>}
        {data && data.items.length === 0 && (
          <div className="px-4 py-16 text-center">
            <p className="font-medium">{activeFilterCount ? 'No plays match your filters' : 'No plays recorded yet'}</p>
            <p className="mt-1 text-sm text-ink-muted">
              {activeFilterCount
                ? 'Try widening the period or clearing a filter.'
                : importing
                  ? 'The import from Silo has just started. Plays will appear shortly.'
                  : 'Plays will appear here as soon as someone finishes watching something.'}
            </p>
          </div>
        )}
      </div>

      {data && data.total > 0 && <Pagination data={data} onPage={(page) => update({ page }, { push: true })} />}
    </div>
  );
}

function SyncLine({ status }: { status: HistorySyncStatus | null }) {
  if (!status) return <p className="text-sm text-ink-muted">&nbsp;</p>;
  return (
    <p className="text-sm text-ink-muted">
      {status.totalPlays.toLocaleString()} plays
      {status.oldestPlayAt && <> since {new Date(status.oldestPlayAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</>}
      {status.lastError && <span className="text-red-300"> · Sync problem: {status.lastError}</span>}
    </p>
  );
}

function HistoryRow({ entry, expanded, onToggle }: { entry: HistoryEntry; expanded: boolean; onToggle: () => void }) {
  const { media } = entry;
  const isEpisode = media.type === 'episode' && media.seriesTitle;
  const percent = media.durationSeconds ? Math.min(100, (entry.endPositionSeconds / media.durationSeconds) * 100) : null;

  return (
    <tr
      onClick={onToggle}
      className={`cursor-pointer border-b border-line/60 last:border-0 hover:bg-panel-raised/60 ${expanded ? 'bg-panel-raised/60' : ''}`}
    >
      <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted" title={formatFullDate(entry.endedAt)}>
        {formatWhen(entry.endedAt)}
      </td>
      <td className="max-w-[10rem] truncate px-3 py-2.5">
        <Link
          to={`/users/${encodeURIComponent(entry.user.id)}`}
          onClick={(e) => e.stopPropagation()}
          className="font-medium text-harvest hover:underline"
        >
          {entry.user.name}
        </Link>
        {entry.user.profileName && entry.user.profileName !== 'Main' && (
          <span className="text-ink-faint"> · {entry.user.profileName}</span>
        )}
      </td>
      <td className="max-w-[22rem] px-3 py-2.5">
        <div className="truncate font-medium" title={isEpisode ? media.seriesTitle! : media.title}>
          {isEpisode ? media.seriesTitle : media.title}
        </div>
        {isEpisode && (
          <div className="truncate text-xs text-ink-muted">
            {[episodeCode(media.seasonNumber, media.episodeNumber), media.title].filter(Boolean).join(' · ')}
          </div>
        )}
      </td>
      <td className="max-w-[12rem] truncate px-3 py-2.5 text-ink-muted">
        {[entry.client.name, platformLabel(entry.client.platform)].filter(Boolean).join(' · ') || '—'}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-xs">
        <MethodBadge method={entry.playback.method} />
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatDuration(entry.watchedSeconds)}</td>
      <td className="px-3 py-2.5">
        {percent == null ? (
          <span className="text-ink-faint">—</span>
        ) : (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-raised">
              <div className={`h-full ${entry.completed ? 'bg-ink-muted' : 'bg-harvest'}`} style={{ width: `${percent}%` }} />
            </div>
            <span className="w-10 text-right text-xs tabular-nums text-ink-muted">
              {entry.completed ? 'Done' : `${Math.round(percent)}%`}
            </span>
          </div>
        )}
      </td>
      <td className="px-2 py-2.5 text-ink-faint">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          className="rounded p-1 hover:text-ink"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </td>
    </tr>
  );
}

function HistoryDetails({ entry }: { entry: HistoryEntry }) {
  const decision = (d: string | null) => (d ? d.charAt(0).toUpperCase() + d.slice(1) : '—');
  const items: [string, React.ReactNode][] = [
    ['Started', formatFullDate(entry.startedAt)],
    ['Ended', formatFullDate(entry.endedAt)],
    [
      'Position',
      `${entry.startPositionSeconds != null ? formatClock(entry.startPositionSeconds) : '?'} → ${formatClock(entry.endPositionSeconds)}${
        entry.media.durationSeconds ? ` of ${formatClock(entry.media.durationSeconds)}` : ''
      }`,
    ],
    ['Watched', formatDuration(entry.watchedSeconds)],
    ['Paused', formatDuration(entry.pausedSeconds)],
    ['Video', decision(entry.playback.videoDecision)],
    ['Audio', decision(entry.playback.audioDecision)],
    ['Subtitles', entry.subtitle ? [entry.subtitle.language?.toUpperCase(), codecLabel(entry.subtitle.codec)].filter(Boolean).join(' ') : 'None'],
    ['Player', [entry.client.name, entry.client.version].filter(Boolean).join(' ') || '—'],
    ['Platform', platformLabel(entry.client.platform) ?? '—'],
    ['IP address', entry.client.ip ?? '—'],
    ['Ended because', endReasonLabel(entry.endReason)],
  ];

  return (
    <tr className="border-b border-line/60 bg-panel-raised/40">
      <td colSpan={8} className="px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
          {items.map(([label, value]) => (
            <div key={label}>
              <dt className="text-ink-faint">{label}</dt>
              <dd className="mt-0.5 text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </td>
    </tr>
  );
}

function SortHeader({
  label,
  sort,
  filters,
  onSort,
  align = 'left',
}: {
  label: string;
  sort: HistorySort;
  filters: Filters;
  onSort: (sort: HistorySort) => void;
  align?: 'left' | 'right';
}) {
  const active = filters.sort === sort;
  return (
    <th
      className={`px-3 py-2.5 font-medium ${align === 'right' ? 'text-right' : ''}`}
      aria-sort={active ? (filters.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sort)}
        className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink ${active ? 'text-ink' : ''}`}
      >
        {label}
        <span aria-hidden="true" className={active ? 'text-harvest' : 'invisible'}>
          {filters.direction === 'asc' && active ? '↑' : '↓'}
        </span>
      </button>
    </th>
  );
}

function Select({
  label,
  value,
  active = Boolean(value),
  onChange,
  children,
}: {
  label: string;
  value: string;
  /** Whether the filter is set to something other than its default, which highlights it. */
  active?: boolean;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`min-w-0 rounded-lg border bg-canvas px-2 py-2 text-sm focus:border-harvest-dim focus:outline-none ${
        active ? 'border-harvest-dim text-ink' : 'border-line text-ink-muted'
      }`}
    >
      {children}
    </select>
  );
}

function Pagination({ data, onPage }: { data: HistoryPageData; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const first = (data.page - 1) * data.pageSize + 1;
  const last = Math.min(data.total, data.page * data.pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-muted">
      <p className="tabular-nums">
        Showing {first.toLocaleString()}–{last.toLocaleString()} of {data.total.toLocaleString()}
      </p>
      <div className="flex items-center gap-1">
        <PageButton disabled={data.page <= 1} onClick={() => onPage(1)} label="First page">
          «
        </PageButton>
        <PageButton disabled={data.page <= 1} onClick={() => onPage(data.page - 1)} label="Previous page">
          ‹ Previous
        </PageButton>
        <span className="px-2 tabular-nums">
          Page {data.page.toLocaleString()} of {pages.toLocaleString()}
        </span>
        <PageButton disabled={data.page >= pages} onClick={() => onPage(data.page + 1)} label="Next page">
          Next ›
        </PageButton>
        <PageButton disabled={data.page >= pages} onClick={() => onPage(pages)} label="Last page">
          »
        </PageButton>
      </div>
    </div>
  );
}

function PageButton({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        onClick();
        window.scrollTo({ top: 0 });
      }}
      aria-label={label}
      className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-ink hover:border-harvest-dim disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line"
    >
      {children}
    </button>
  );
}
