import { useEffect, useMemo, useState } from 'react';
import { LOAD_RANGES, type LoadRange, type LoadResponse, type NodeInfo, type NodesResponse } from '../../../shared/load';
import { LineChart } from '../components/charts/LineChart';
import { WeekHourHeatmap } from '../components/charts/WeekHourHeatmap';
import { Stat } from '../components/StatsSections';
import { api } from '../lib/api';
import { formatWhen } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { DownloadsTab } from './DownloadsTab';
import { ReliabilityTab } from './ReliabilityTab';
import { TranscodesTab } from './TranscodesTab';

type Tab = 'load' | 'nodes' | 'transcodes' | 'reliability' | 'downloads';
const TABS: [Tab, string][] = [
  ['load', 'Load'],
  ['nodes', 'Nodes'],
  ['transcodes', 'Transcodes'],
  ['reliability', 'Reliability'],
  ['downloads', 'Downloads'],
];

const COLORS = { peak: '#9085e9', average: '#3987e5', transcodes: '#d95926' };

export function ServerPage() {
  const { pathname, search } = useLocation();
  const tab = (TABS.find(([t]) => pathname === `/server/${t}`)?.[0] ?? 'load') as Tab;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Server</h1>
        <p className="text-sm text-ink-muted">How hard Silo is working, node by node, what makes it transcode, how reliably streams play, and what people download.</p>
      </div>
      <nav
        ref={(nav) => {
          // On a phone not every tab fits: keep the open one in view.
          const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
          if (current && nav && (current.offsetLeft + current.offsetWidth > nav.scrollLeft + nav.clientWidth || current.offsetLeft < nav.scrollLeft)) {
            nav.scrollLeft = current.offsetLeft - 16;
          }
        }}
        className="relative flex gap-1 overflow-x-auto border-b border-line"
        aria-label="Server sections"
      >
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            to={t === 'load' ? '/server' : `/server/${t}`}
            aria-current={tab === t ? 'page' : undefined}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {tab === 'load' && <LoadTab search={search} />}
      {tab === 'nodes' && <NodesTab />}
      {tab === 'transcodes' && <TranscodesTab />}
      {tab === 'reliability' && <ReliabilityTab search={search} />}
      {tab === 'downloads' && <DownloadsTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LoadTab({ search }: { search: string }) {
  const range = (LOAD_RANGES.find((r) => r.key === new URLSearchParams(search).get('range'))?.key ?? '24h') as LoadRange['key'];
  const [data, setData] = useState<LoadResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = () =>
      api<LoadResponse>(`/api/server/load?range=${range}`)
        .then((d) => !cancelled && setData(d))
        .catch(() => {})
        .finally(() => !cancelled && setLoading(false));
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [range]);

  const hours = LOAD_RANGES.find((r) => r.key === range)!.hours;
  const axisTime = (t: number) =>
    hours <= 24
      ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const fullTime = (t: number) =>
    new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  const week = useMemo(() => (data ? typicalWeek(data.weekly) : null), [data]);

  return (
    <div className="space-y-5">
      <div className="relative flex max-w-full overflow-x-auto rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Period">
        {LOAD_RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            aria-pressed={r.key === range}
            onClick={() => navigate(r.key === '24h' ? '/server' : `/server?range=${r.key}`, { replace: true })}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${r.key === range ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {!data && <p className="py-16 text-center text-sm text-ink-muted">Loading…</p>}
      {data && (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Peak streams" value={data.peak.streams.toLocaleString()} detail={data.peak.streamsAt ? formatWhen(data.peak.streamsAt) : undefined} />
            <Stat label="Average streams" value={data.average.streams.toLocaleString()} detail={`over ${LOAD_RANGES.find((r) => r.key === range)!.label}`} />
            <Stat label="Peak bandwidth" value={`${data.peak.mbps.toLocaleString()} Mbps`} detail={data.peak.mbpsAt ? formatWhen(data.peak.mbpsAt) : undefined} />
            <Stat label="Average bandwidth" value={`${data.average.mbps.toLocaleString()} Mbps`} detail={`peak transcodes: ${data.peak.transcodes}`} />
          </div>

          <section className="rounded-xl border border-line bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Streams at once</h2>
            <LineChart
              label="Streams at once over time"
              series={[
                // On 24 hours each point is one 5-minute sample, so peak and average are the same.
                ...(hours > 24 ? [{ key: 'peak' as const, label: 'Peak', color: COLORS.peak, dashed: true }] : []),
                { key: 'average', label: hours > 24 ? 'Average' : 'Streams', color: COLORS.average, fill: true },
                { key: 'transcodes', label: hours > 24 ? 'Transcodes (average)' : 'Transcodes', color: COLORS.transcodes },
              ]}
              points={data.buckets.map(([t, avg, max, avgT]) => ({ t: t * 1000, values: { peak: max, average: avg, transcodes: avgT } }))}
              formatTime={fullTime}
              formatAxisTime={axisTime}
            />
          </section>

          <section className="rounded-xl border border-line bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold">Bandwidth (Mbps)</h2>
            <LineChart
              label="Bandwidth over time"
              series={[
                ...(hours > 24 ? [{ key: 'peak' as const, label: 'Peak', color: COLORS.peak, dashed: true }] : []),
                { key: 'average', label: hours > 24 ? 'Average' : 'Bandwidth', color: COLORS.average, fill: true },
              ]}
              points={data.buckets.map(([t, , , , , avgMbps, maxMbps]) => ({ t: t * 1000, values: { peak: maxMbps, average: avgMbps } }))}
              formatValue={(v) => `${Math.round(v).toLocaleString()}`}
              formatTime={fullTime}
              formatAxisTime={axisTime}
            />
          </section>

          {week && (
            <section className="rounded-xl border border-line bg-panel p-4">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">A typical week</h2>
                {week.quietest && (
                  <p className="text-sm text-ink-muted">
                    Quietest time: <strong className="text-ink">{week.quietest}</strong>, the best window for maintenance.
                  </p>
                )}
              </div>
              <WeekHourHeatmap grid={week.grid} label="Average streams by day of the week and hour" unit="streams on average" share={false} />
              <p className="mt-2 text-[11px] text-ink-faint">Average streams over the last 4 weeks, in your time zone.</p>
            </section>
          )}

          {data.since && (
            <p className="text-xs text-ink-faint">
              Almanac has load history from {new Date(data.since).toLocaleDateString(undefined, { dateStyle: 'medium' })}. Silo keeps about 31 days;
              Almanac keeps it for good.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const DAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/** Average streams by local weekday and hour, and the quietest 3-hour window. */
function typicalWeek(weekly: [number, number][]) {
  if (weekly.length < 24) return null;
  const sums = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const counts = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const [t, avg] of weekly) {
    const d = new Date(t * 1000);
    const day = (d.getDay() + 6) % 7;
    sums[day]![d.getHours()]! += avg;
    counts[day]![d.getHours()]! += 1;
  }
  const grid = sums.map((row, d) => row.map((sum, h) => (counts[d]![h] ? Math.round((sum / counts[d]![h]!) * 10) / 10 : 0)));

  let best: { day: number; hour: number; value: number } | null = null;
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const cells = [0, 1, 2].map((i) => {
        const h = hour + i;
        return grid[(day + Math.floor(h / 24)) % 7]![h % 24]!;
      });
      const covered = [0, 1, 2].every((i) => counts[(day + Math.floor((hour + i) / 24)) % 7]![(hour + i) % 24]! > 0);
      if (!covered) continue;
      const value = cells.reduce((a, b) => a + b, 0) / 3;
      if (!best || value < best.value) best = { day, hour, value };
    }
  }
  const time = (h: number) => new Date(2000, 0, 1, h % 24).toLocaleTimeString(undefined, { hour: 'numeric' });
  const quietest = best ? `${DAYS[best.day]} ${time(best.hour)}–${time(best.hour + 3)} (about ${Math.round(best.value)} streams)` : null;
  return { grid, quietest };
}

// ---------------------------------------------------------------------------

function NodesTab() {
  const [data, setData] = useState<NodesResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api<NodesResponse>('/api/server/nodes').then((d) => !cancelled && setData(d)).catch(() => {});
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data) return <p className="py-16 text-center text-sm text-ink-muted">Loading…</p>;
  const nodes = data.nodes;
  const healthy = nodes.filter((n) => n.healthy && n.enabled).length;
  const totalMbps = nodes.reduce((sum, n) => sum + n.egressMbps, 0);
  const maxMbps = Math.max(1, ...nodes.map((n) => n.egressMbps));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Healthy" value={`${healthy}/${nodes.length}`} detail={healthy === nodes.length ? 'all nodes OK' : `${nodes.length - healthy} need attention`} />
        <Stat label="Bandwidth now" value={`${Math.round(totalMbps).toLocaleString()} Mbps`} detail="across all nodes" />
        <Stat label="Live streams" value={nodes.reduce((s, n) => s + n.streams, 0).toLocaleString()} detail="going out through nodes" />
        <Stat label="Active jobs" value={nodes.reduce((s, n) => s + n.activeJobs, 0).toLocaleString()} detail="transcodes and remuxes" />
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wider text-ink-faint">
              <tr>
                <th className="px-3 py-2.5 font-medium">Node</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Streams</th>
                <th className="w-48 px-3 py-2.5 font-medium">Bandwidth</th>
                <th className="w-40 px-3 py-2.5 font-medium">CPU</th>
                <th className="px-3 py-2.5 font-medium">Memory</th>
                <th className="px-3 py-2.5 text-right font-medium">Jobs</th>
                <th className="px-3 py-2.5 font-medium">Checked</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.id} className="border-b border-line/60 last:border-0">
                  <td className="px-3 py-2.5">
                    <span className="font-medium">{n.name}</span>
                    <span className="ml-2 text-xs text-ink-faint">{[n.type, n.group].filter(Boolean).join(' · ')}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <NodeStatus node={n} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{n.streams || <span className="text-ink-faint">0</span>}</td>
                  <td className="px-3 py-2.5">
                    <Meter value={n.egressMbps} max={maxMbps} label={`${Math.round(n.egressMbps).toLocaleString()} Mbps`} />
                  </td>
                  <td className="px-3 py-2.5">
                    {n.cpuPercent == null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <Meter value={n.cpuPercent} max={100} label={`${Math.round(n.cpuPercent)}%${n.cores ? ` of ${n.cores}` : ''}`} warn={n.cpuPercent >= 85} />
                    )}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-ink-muted">
                    {n.memoryUsedGb != null && n.memoryTotalGb ? `${n.memoryUsedGb} / ${n.memoryTotalGb} GB` : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{n.activeJobs}</td>
                  <td className="px-3 py-2.5 text-ink-faint">{n.lastHealthCheck ? formatWhen(n.lastHealthCheck) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nodes.length === 0 && <p className="px-4 py-12 text-center text-sm text-ink-muted">No nodes reported by Silo.</p>}
      </div>
      {data.checkedAt && <p className="text-xs text-ink-faint">Updated {formatWhen(data.checkedAt)}. Refreshes every minute.</p>}
    </div>
  );
}

function NodeStatus({ node }: { node: NodeInfo }) {
  const [label, color] = !node.enabled
    ? ['Disabled', '#737373']
    : !node.healthy
      ? ['Unhealthy', '#d03b3b']
      : node.draining
        ? ['Draining', '#fab219']
        : ['Healthy', '#0ca30c'];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function Meter({ value, max, label, warn }: { value: number; max: number; label: string; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-raised">
        <div className={`h-full rounded-full ${warn ? 'bg-[#fab219]' : 'bg-accent-dim'}`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </div>
      <span className="w-24 text-right text-xs tabular-nums text-ink-muted">{label}</span>
    </div>
  );
}
