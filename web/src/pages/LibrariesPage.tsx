import { useEffect, useMemo, useState } from 'react';
import type { LibrariesResponse, LibrarySummary, RecentlyAddedItem, RecentlyAddedResponse } from '../../../shared/library';
import { formatWhen } from '../lib/format';
import { navigate, useLocation } from '../lib/router';

type Kind = '' | 'movie' | 'show';

export function LibrariesPage() {
  const { search } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const libraryId = params.get('library') ?? '';
  const kind = (['movie', 'show'].includes(params.get('kind') ?? '') ? params.get('kind') : '') as Kind;
  const days = params.get('days') === '7' ? 7 : 30;

  const [data, setData] = useState<LibrariesResponse | null>(null);
  const [recent, setRecent] = useState<RecentlyAddedItem[] | null>(null);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setParam = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const q = next.toString();
    navigate(`/libraries${q ? `?${q}` : ''}`, { replace: true });
  };

  // Library list; poll while the first catalog copy is still running.
  const ready = data?.status.ready ?? false;
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/libraries')
        .then((r) => {
          if (!r.ok) throw new Error(`Almanac returned ${r.status}`);
          return r.json() as Promise<LibrariesResponse>;
        })
        .then((d) => !cancelled && setData(d))
        .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    void load();
    const id = setInterval(load, ready ? 5 * 60_000 : 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ready]);

  useEffect(() => {
    const controller = new AbortController();
    const q = new URLSearchParams({ days: String(days), limit: '96' });
    if (libraryId) q.set('library', libraryId);
    if (kind) q.set('kind', kind);
    setLoadingRecent(true);
    fetch(`/api/libraries/recent?${q}`, { signal: controller.signal })
      .then((r) => r.json() as Promise<RecentlyAddedResponse>)
      .then((d) => setRecent(d.items))
      .catch(() => {})
      .finally(() => !controller.signal.aborted && setLoadingRecent(false));
    return () => controller.abort();
  }, [libraryId, kind, days, data?.status.lastRecentSyncAt]);

  const names = new Map(data?.libraries.map((l) => [l.id, l.name]));
  const selected = data?.libraries.find((l) => l.id === libraryId);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Libraries</h1>
        <p className="text-sm text-ink-muted">
          {data
            ? `${data.totals.movies.toLocaleString()} movies and ${data.totals.shows.toLocaleString()} shows across ${data.libraries.length} libraries.`
            : ' '}
        </p>
      </div>

      {data && !data.status.ready && (
        <div role="status" className="flex items-center gap-3 rounded-lg border border-accent-dim/60 bg-accent/10 px-4 py-3 text-sm">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden="true" />
          Copying your catalog from Silo. Counts will fill in over the next few minutes.
        </div>
      )}
      {data && !data.status.libraryNamesAvailable && (
        <div role="status" className="rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink-muted">
          Library names aren’t available because Almanac’s Silo API key doesn’t have the <code className="text-ink">libraries:read</code> scope.
          Create a key with <code className="text-ink">admin:monitor:read</code> and <code className="text-ink">libraries:read</code> to show them.
        </div>
      )}
      {(error || data?.status.lastError) && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error ? `Couldn’t load libraries: ${error}` : `Sync problem: ${data?.status.lastError}`}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
          {data.libraries.map((l) => (
            <LibraryCard
              key={l.id}
              library={l}
              selected={l.id === libraryId}
              onSelect={() => setParam({ library: l.id === libraryId ? null : l.id })}
            />
          ))}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-lg font-semibold">Recently added{selected ? ` to ${selected.name}` : ''}</h2>
          <Segmented
            label="Type"
            value={kind}
            options={[
              ['', 'Everything'],
              ['movie', 'Movies'],
              ['show', 'Shows'],
            ]}
            onChange={(v) => setParam({ kind: v || null })}
          />
          <Segmented
            label="Period"
            value={String(days)}
            options={[
              ['7', '7 days'],
              ['30', '30 days'],
            ]}
            onChange={(v) => setParam({ days: v === '30' ? null : v })}
          />
          {selected && (
            <button type="button" onClick={() => setParam({ library: null })} className="text-sm text-accent hover:underline">
              Show all libraries
            </button>
          )}
        </div>

        <div className={`transition-opacity ${loadingRecent && recent ? 'opacity-60' : ''}`}>
          {recent && recent.length === 0 && (
            <p className="rounded-xl border border-dashed border-line px-6 py-16 text-center text-sm text-ink-muted">
              Nothing added in the last {days} days{selected ? ` to ${selected.name}` : ''}.
            </p>
          )}
          <ul className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-10">
            {recent?.map((item) => (
              <RecentCard key={item.id} item={item} libraryNames={names} />
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function LibraryCard({ library, selected, onSelect }: { library: LibrarySummary; selected: boolean; onSelect: () => void }) {
  const isShows = library.type === 'series' || library.type === 'shows' || library.shows > library.movies;
  const count = isShows ? library.shows : library.movies;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-xl border bg-panel p-4 text-left transition-colors hover:border-accent-dim ${selected ? 'border-accent' : 'border-line'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold">{library.name}</h3>
        <span className="rounded border border-line px-1.5 py-px text-[11px] text-ink-muted">{isShows ? 'Shows' : 'Movies'}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{count.toLocaleString()}</p>
      <p className="text-sm text-ink-muted">{isShows ? (count === 1 ? 'show' : 'shows') : count === 1 ? 'movie' : 'movies'}</p>
      <div className="mt-3 flex gap-4 border-t border-line pt-3 text-xs text-ink-muted">
        <span>
          <span className="font-medium tabular-nums text-ink">{library.addedLastWeek.toLocaleString()}</span> added this week
        </span>
        <span>
          <span className="font-medium tabular-nums text-ink">{library.playsLast30Days.toLocaleString()}</span> plays in 30 days
        </span>
      </div>
    </button>
  );
}

function RecentCard({ item, libraryNames }: { item: RecentlyAddedItem; libraryNames: Map<string, string> }) {
  const [failed, setFailed] = useState(false);
  const badges = [item.resolution === '2160p' ? '4K' : null, dynamicRangeLabel(item.dynamicRange)].filter(Boolean) as string[];
  const library = item.libraryIds.map((id) => libraryNames.get(id) ?? `Library ${id}`).join(', ');

  return (
    <li className="min-w-0">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg border border-line bg-panel-raised">
        {item.posterUrl && !failed ? (
          <img src={item.posterUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-3 text-center text-xs text-ink-faint">{item.title}</div>
        )}
        {badges.length > 0 && (
          <div className="absolute left-1.5 top-1.5 flex gap-1">
            {badges.map((b) => (
              <span key={b} className="rounded bg-canvas/85 px-1.5 py-px text-[10px] font-semibold text-ink">
                {b}
              </span>
            ))}
          </div>
        )}
        {(item.episodeCount || item.isNewShow) && (
          <span className="absolute bottom-1.5 left-1.5 rounded bg-canvas/85 px-1.5 py-px text-[11px] font-medium text-ink">
            {item.isNewShow ? 'New show' : `${item.episodeCount} new ${item.episodeCount === 1 ? 'episode' : 'episodes'}`}
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate text-sm font-medium" title={item.title}>
        {item.title}
      </p>
      <p className="truncate text-xs text-ink-muted">
        {item.episodeCount
          ? [item.episodeRange, item.isNewShow ? `${item.episodeCount} ${item.episodeCount === 1 ? 'episode' : 'episodes'}` : null].filter(Boolean).join(' · ')
          : item.year}
      </p>
      <p className="truncate text-xs text-ink-faint" title={library}>
        {formatWhen(item.addedAt)}
      </p>
    </li>
  );
}

/** Badge text for HDR formats; nothing for SDR or unknown. Silo's values vary in case. */
function dynamicRangeLabel(value: string | null): string | null {
  if (!value) return null;
  const v = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'sdr' || v === 'unknown') return null;
  if (v.includes('dolby') || v === 'dv' || v.startsWith('dovi')) return 'Dolby Vision';
  if (v === 'hlg') return 'HLG';
  if (v.includes('hdr10_plus') || v.includes('hdr10+')) return 'HDR10+';
  return 'HDR';
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors ${
            value === v ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
