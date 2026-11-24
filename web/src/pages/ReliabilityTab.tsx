import { useEffect, useState } from 'react';
import { RELIABILITY_RANGES, type ReliabilityGroup, type ReliabilityRange, type ReliabilityResponse } from '../../../shared/reliability';
import { LineChart } from '../components/charts/LineChart';
import { Stat } from '../components/StatsSections';
import { api } from '../lib/api';
import { formatRate, platformLabel } from '../lib/format';
import { navigate } from '../lib/router';

const COLORS = { dropped: '#d95926', quick: '#9085e9' };
/** Fewer plays than this in a chart bucket and its rate is left out: too noisy. */
const MIN_BUCKET_PLAYS = 5;

/** Server → Reliability: are streams playing properly? */
export function ReliabilityTab({ search }: { search: string }) {
  const param = new URLSearchParams(search).get('range') ?? '7d';
  const range = (param in RELIABILITY_RANGES ? param : '7d') as ReliabilityRange;
  const [data, setData] = useState<ReliabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<ReliabilityResponse>(`/api/server/reliability?range=${range}`)
      .then((d) => !cancelled && setData(d))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  const rate = (part: number, whole: number) => (whole ? part / whole : null);
  const compare = (value: number | null, typical: number | null) => {
    if (value == null || typical == null) return undefined;
    const diff = value - typical;
    if (Math.abs(diff) < 0.01) return `about usual (${formatRate(typical)})`;
    return `${diff > 0 ? 'up' : 'down'} from a usual ${formatRate(typical)}`;
  };

  return (
    <div className="space-y-5">
      <div className="relative flex max-w-full overflow-x-auto rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Period">
        {(Object.keys(RELIABILITY_RANGES) as ReliabilityRange[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={key === range}
            onClick={() => navigate(key === '7d' ? '/server/reliability' : `/server/reliability?range=${key}`, { replace: true })}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${key === range ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            {RELIABILITY_RANGES[key].label}
          </button>
        ))}
      </div>

      {!data && <p className="py-16 text-center text-sm text-ink-muted">Loading…</p>}
      {data && (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Streams started"
              value={(data.silo?.sessionsStarted ?? data.totals.plays).toLocaleString()}
              detail={data.silo ? `${data.silo.profiles.toLocaleString()} profiles · ${data.silo.transcodeStarts.toLocaleString()} transcodes` : 'from Almanac’s history'}
            />
            <Stat label="Watched to the end" value={formatRate(data.silo?.watchedToEnd)} detail="of finished streams, says Silo" />
            <Stat
              label="Dropped"
              value={formatRate(rate(data.totals.dropped, data.totals.plays))}
              detail={compare(rate(data.totals.dropped, data.totals.plays), data.typical.droppedRate) ?? `${data.totals.dropped.toLocaleString()} streams`}
            />
            <Stat
              label="Stopped within 10 seconds"
              value={formatRate(rate(data.totals.quickStops, data.totals.plays))}
              detail={compare(rate(data.totals.quickStops, data.totals.plays), data.typical.quickStopRate) ?? `${data.totals.quickStops.toLocaleString()} streams`}
            />
          </div>

          <section className="rounded-xl border border-line bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Share of streams, {data.bucketHours === 1 ? 'by hour' : 'by day'}</h2>
            <LineChart
              label="Share of streams that dropped or stopped quickly over time"
              series={[
                { key: 'dropped', label: 'Dropped', color: COLORS.dropped },
                { key: 'quick', label: 'Stopped within 10 seconds', color: COLORS.quick },
              ]}
              points={data.buckets
                .filter(([, plays]) => plays >= MIN_BUCKET_PLAYS)
                .map(([t, plays, dropped, quick]) => ({ t, values: { dropped: (dropped / plays) * 100, quick: (quick / plays) * 100 } }))}
              formatValue={(v) => `${v.toFixed(1)}%`}
              formatTime={(t) =>
                new Date(t).toLocaleString(undefined, data.bucketHours === 1 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short' })
              }
              formatAxisTime={(t) =>
                data.bucketHours === 1
                  ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric' })
                  : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
              }
            />
          </section>

          <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
            <GroupTable title="By player" groups={data.players} overall={data.totals} showPlatform />
            <GroupTable title="By playback method" groups={data.methods} overall={data.totals} />
          </div>

          <p className="text-xs text-ink-faint">
            A stream has <strong className="font-medium text-ink-muted">dropped</strong> when Silo stopped hearing from the player mid-stream: the app crashed or
            froze, the connection was lost, or (very often on phones) the screen was locked or the app put in the background. So phones always drop more than TVs;
            look for changes rather than the numbers themselves. <strong className="font-medium text-ink-muted">Stopped within 10 seconds</strong> includes streams that
            wouldn’t start as well as people changing their mind. Admins can get a Discord alert when drops jump: Notifications → Staff alerts.
          </p>
        </div>
      )}
    </div>
  );
}

function GroupTable({ title, groups, overall, showPlatform }: { title: string; groups: ReliabilityGroup[]; overall: { plays: number; dropped: number; quickStops: number }; showPlatform?: boolean }) {
  const overallDropped = overall.plays ? overall.dropped / overall.plays : 0;
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <h2 className="px-4 pt-4 text-sm font-semibold">{title}</h2>
      {groups.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-faint">No streams in this period.</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-ink-faint">
            <tr>
              <th className="px-4 py-2 font-medium">{showPlatform ? 'Player' : 'Method'}</th>
              <th className="px-4 py-2 text-right font-medium">Streams</th>
              <th className="px-4 py-2 text-right font-medium">Dropped</th>
              <th className="px-4 py-2 text-right font-medium">Within 10 s</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const dropped = g.plays ? g.dropped / g.plays : 0;
              // Well above everyone else, with enough streams to mean something.
              const stands = g.plays >= 30 && dropped >= Math.max(overallDropped * 2, overallDropped + 0.1);
              return (
                <tr key={g.key} className="border-t border-line/60">
                  <td className="px-4 py-2">
                    <span className="font-medium">{g.label}</span>
                    {showPlatform && g.platform && <span className="ml-1.5 text-xs text-ink-faint">{platformLabel(g.platform)}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{g.plays.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    <span className="inline-flex items-center justify-end gap-1">
                      {stands && (
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="#fab219" strokeWidth="1.8" strokeLinecap="round" aria-label="Much higher than average">
                          <path d="M8 1.5 15 14H1L8 1.5Zm0 4v4m0 2.2v.3" />
                        </svg>
                      )}
                      {formatRate(g.plays ? dropped : null)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatRate(g.plays ? g.quickStops / g.plays : null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
