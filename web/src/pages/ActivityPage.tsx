import { useMemo, useState } from 'react';
import type { ActivityStream, PlayMethod } from '../../../shared/activity';
import { METHOD_STYLES } from '../components/MethodBadge';
import { StreamCard } from '../components/StreamCard';
import { SummaryTiles } from '../components/SummaryTiles';
import { PLAY_METHOD_LABELS, livePosition, titleLines } from '../lib/format';
import { useAuth } from '../auth/AuthGate';
import { useActivity, useNow } from '../lib/useActivity';

type SortKey = 'newest' | 'user' | 'title' | 'bandwidth' | 'remaining';

const SORTS: Record<SortKey, { label: string; compare: (a: ActivityStream, b: ActivityStream) => number }> = {
  newest: { label: 'Most recent', compare: (a, b) => b.progress.startedAt.localeCompare(a.progress.startedAt) },
  user: { label: 'User', compare: (a, b) => a.user.name.localeCompare(b.user.name) },
  title: { label: 'Title', compare: (a, b) => titleLines(a).title.localeCompare(titleLines(b).title) },
  bandwidth: { label: 'Bandwidth', compare: (a, b) => (b.bandwidth.streamKbps ?? 0) - (a.bandwidth.streamKbps ?? 0) },
  remaining: {
    label: 'Finishing soonest',
    compare: (a, b) => remaining(a) - remaining(b),
  },
};

function remaining(s: ActivityStream): number {
  return s.media.durationSeconds ? s.media.durationSeconds - s.progress.positionSeconds : Number.MAX_SAFE_INTEGER;
}

const METHODS: PlayMethod[] = ['direct', 'direct_stream', 'remux', 'transcode'];

export function ActivityPage() {
  const { snapshot, receivedAt, connection } = useActivity();
  const canSeeIps = useAuth().can('viewIpAddresses');
  const now = useNow();
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState<PlayMethod | 'all'>('all');
  const [sort, setSort] = useState<SortKey>('newest');

  const streams = useMemo(() => {
    if (!snapshot) return [];
    const q = query.trim().toLowerCase();
    return snapshot.streams
      .filter((s) => method === 'all' || s.playback.method === method)
      .filter((s) => {
        if (!q) return true;
        const haystack = [
          s.user.name,
          s.user.profileName,
          s.media.title,
          s.media.seriesTitle,
          s.client.name,
          s.client.platform,
          s.client.ip,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort(SORTS[sort].compare);
  }, [snapshot, query, method, sort]);

  if (!snapshot) {
    return <CenteredMessage title="Connecting to Almanac…" />;
  }

  const neverConnected = !snapshot.fetchedAt;

  return (
    <div className="space-y-5">
      {connection === 'reconnecting' && (
        <Banner tone="warn">Lost connection to the Almanac server. Reconnecting…</Banner>
      )}
      {snapshot.error && (
        <Banner tone="error">
          <strong className="font-semibold">Can’t reach Silo.</strong> {snapshot.error}
          {!neverConnected && ' Showing the last known activity.'}
        </Banner>
      )}

      {!neverConnected && <SummaryTiles summary={snapshot.summary} />}

      {snapshot.streams.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={canSeeIps ? 'Search user, title, player or IP' : 'Search user, title or player'}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm placeholder:text-ink-faint focus:border-harvest-dim focus:outline-none sm:max-w-xs"
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by playback">
            <FilterChip active={method === 'all'} onClick={() => setMethod('all')}>
              All
            </FilterChip>
            {METHODS.map((m) => (
              <FilterChip key={m} active={method === m} onClick={() => setMethod(m)}>
                <span className={`h-1.5 w-1.5 rounded-full ${METHOD_STYLES[m].dot}`} aria-hidden="true" />
                {PLAY_METHOD_LABELS[m]}
                <span className="tabular-nums text-ink-faint">{snapshot.summary.byMethod[m]}</span>
              </FilterChip>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-muted sm:ml-auto">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-line bg-panel px-2 py-1.5 text-ink focus:border-harvest-dim focus:outline-none"
            >
              {(Object.keys(SORTS) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {SORTS[key].label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {neverConnected && !snapshot.error ? (
        <CenteredMessage title="Waiting for Silo…" />
      ) : snapshot.streams.length === 0 && !neverConnected ? (
        <CenteredMessage title="Nothing is playing right now" detail="Streams will appear here as soon as someone presses play." />
      ) : streams.length === 0 && snapshot.streams.length > 0 ? (
        <CenteredMessage title="No streams match your filters" />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {streams.map((stream) => (
            <StreamCard
              key={stream.id}
              stream={stream}
              position={livePosition(stream, snapshot.fetchedAt, receivedAt, now)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active ? 'border-harvest-dim bg-harvest/10 text-ink' : 'border-line bg-panel text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function Banner({ tone, children }: { tone: 'warn' | 'error'; children: React.ReactNode }) {
  const styles = tone === 'error' ? 'border-red-900/60 bg-red-950/40 text-red-200' : 'border-amber-900/60 bg-amber-950/40 text-amber-200';
  return (
    <div role="status" className={`rounded-lg border px-4 py-3 text-sm ${styles}`}>
      {children}
    </div>
  );
}

function CenteredMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-20 text-center">
      <p className="text-base font-medium text-ink">{title}</p>
      {detail && <p className="mt-1 text-sm text-ink-muted">{detail}</p>}
    </div>
  );
}
