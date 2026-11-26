import { type FormEvent, useEffect, useState } from 'react';
import { CAPACITY_METRICS, type CapacityMetric, type CapacityMetricReport, type CapacityReport, type CapacityStatus } from '../../../shared/capacity';
import { useAuth } from '../auth/AuthGate';
import { LineChart } from '../components/charts/LineChart';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';

const input = 'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm tabular-nums placeholder:text-ink-faint focus:border-accent-dim focus:outline-none';
const primary = 'rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50';

const COLORS = { peak: '#3987e5', trend: '#9085e9', limit: '#d95926' };

const STATUS: Record<CapacityStatus, { label: string; color: string }> = {
  ok: { label: 'Plenty of room', color: '#0ca30c' },
  watch: { label: 'Worth watching', color: '#fab219' },
  tight: { label: 'Nearly out of room', color: '#d03b3b' },
  unknown: { label: 'No limit set', color: '#737373' },
};

/** Server → Capacity: will busy evenings outgrow the server, and when? */
export function CapacityTab() {
  const { can } = useAuth();
  const [data, setData] = useState<CapacityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<CapacityReport>('/api/server/capacity')
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Couldn’t load capacity.'));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="py-16 text-center text-sm text-red-200">{error}</p>;
  if (!data) return <p className="py-16 text-center text-sm text-ink-muted">Loading…</p>;
  const forecasting = data.historyDays >= data.minimumDays;

  return (
    <div className="space-y-5">
      {!forecasting && (
        <p className="rounded-xl border border-line bg-panel p-4 text-sm text-ink-muted">
          Almanac has {data.historyDays} {data.historyDays === 1 ? 'day' : 'days'} of load history so far. Trends and forecasts appear once it has {data.minimumDays}; until
          then, this shows the busiest evenings against your limits.
        </p>
      )}
      {data.metrics.map((m) => (
        <MetricCard key={m.metric} m={m} />
      ))}
      {can('configureCapacity') ? (
        <LimitsForm data={data} onSaved={setData} />
      ) : (
        <p className="text-xs text-ink-faint">An admin sets the limits these are measured against.</p>
      )}
      <p className="text-xs text-ink-faint">
        Each day’s peak is its busiest hour (averaged over the hour, so a few seconds’ spike doesn’t count). The trend is a straight line through the last 8 weeks
        that one unusual night can’t bend, and the forecast follows your busiest evenings rather than typical ones. Admins can get a Discord alert as a limit gets
        close: Notifications → Staff alerts.
      </p>
    </div>
  );
}

function MetricCard({ m }: { m: CapacityMetricReport }) {
  const info = CAPACITY_METRICS.find((c) => c.key === m.metric)!;
  const status = STATUS[m.status];
  const fmt = (v: number) => `${Math.round(v).toLocaleString()}${m.metric === 'mbps' ? ' Mbps' : ''}`;

  // Past peaks, then the trend line on into the forecast, with the limit across the whole chart.
  type Key = 'peak' | 'trend' | 'limit';
  const points: { t: number; values: Partial<Record<Key, number>> }[] = m.days.map(([t, v]) => ({ t, values: { peak: v } }));
  if (m.trend.length === 3) {
    const [[t0, v0], [tNow, vNow], [tEnd, vEnd]] = m.trend as [[number, number], [number, number], [number, number]];
    const at = (t: number) => (t <= tNow ? v0 + ((vNow - v0) * (t - t0)) / (tNow - t0 || 1) : vNow + ((vEnd - vNow) * (t - tNow)) / (tEnd - tNow || 1));
    for (const p of points) p.values.trend = Math.round(at(p.t) * 10) / 10;
    const lastDay = m.days.at(-1)?.[0] ?? tNow;
    for (let t = lastDay + 7 * 86_400_000; t <= tEnd; t += 7 * 86_400_000) points.push({ t, values: { trend: Math.round(at(t) * 10) / 10 } });
    if (points.at(-1)!.t < tEnd) points.push({ t: tEnd, values: { trend: vEnd } });
  }
  if (m.limit) for (const p of points) p.values.limit = m.limit;

  const growth = m.growthPerMonth;
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{info.label}</h2>
          <p className="mt-0.5 text-sm text-ink-muted">{summary(m, fmt)}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium" style={{ borderColor: status.color }}>
          <span className="h-2 w-2 rounded-full" style={{ background: status.color }} aria-hidden="true" />
          {status.label}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Figure label="Busiest evening this week" value={m.busiest ? fmt(m.busiest.value) : '—'} detail={m.busiest ? dayName(m.busiest.on) : undefined} />
        <Figure label="Typical evening now" value={m.typical != null ? fmt(m.typical) : '—'} />
        <Figure
          label="Trend"
          value={growth == null ? '—' : Math.abs(growth) < 0.01 ? 'Steady' : `${growth > 0 ? '+' : '−'}${Math.round(Math.abs(growth) * 100)}% a month`}
        />
        <Figure label="Limit" value={m.limit ? fmt(m.limit) : 'Not set'} detail={m.used != null ? `${Math.round(m.used * 100)}% used on the busiest evening` : undefined} />
      </dl>
      {points.length > 1 && (
        <div className="mt-4">
          <LineChart<Key>
            label={`${info.label}: evening peaks${m.trend.length ? ', trend and forecast' : ''}${m.limit ? ', and the limit' : ''}`}
            series={[
              { key: 'peak', label: m.metric === 'mbps' ? 'Evening peak (Mbps)' : 'Evening peak', color: COLORS.peak },
              ...(m.trend.length ? [{ key: 'trend' as const, label: 'Trend', color: COLORS.trend, dashed: true }] : []),
              ...(m.limit ? [{ key: 'limit' as const, label: 'Limit', color: COLORS.limit, dashed: true }] : []),
            ]}
            points={points}
            height={200}
            // No unit on the axis: "1,000 Mbps" doesn't fit; the legend says Mbps.
            formatValue={(v) => Math.round(v).toLocaleString()}
            formatTime={(t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
            formatAxisTime={(t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
          />
        </div>
      )}
    </section>
  );
}

function summary(m: CapacityMetricReport, fmt: (v: number) => string): string {
  if (!m.busiest) return 'No load history yet.';
  if (!m.limit) {
    if (m.growthPerMonth == null) return 'Set a limit below to see how much room is left.';
    return `Evening peaks are ${Math.abs(m.growthPerMonth) < 0.01 ? 'steady' : `${m.growthPerMonth > 0 ? 'growing' : 'shrinking'} about ${Math.round(Math.abs(m.growthPerMonth) * 100)}% a month`}. Set a limit below to see when you’d run out of room.`;
  }
  if (m.fullBy) {
    const when = Date.parse(m.fullBy);
    if (when <= Date.now() + 86_400_000) return `Busy evenings are already at your limit of ${fmt(m.limit)}.`;
    return `At this rate, busy evenings reach ${fmt(m.limit)} around ${new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}.`;
  }
  if (m.growthPerMonth == null) return `The busiest evening this week used ${Math.round((m.used ?? 0) * 100)}% of the limit.`;
  return m.growthPerMonth > 0.005 ? 'Growing, but not reaching the limit within a year at this rate.' : 'Not growing: no sign of running out of room.';
}

function Figure({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
      {detail && <dd className="text-xs text-ink-muted">{detail}</dd>}
    </div>
  );
}

function dayName(iso: string): string {
  // Days start at the quietest hour, so name the evening by the day it began.
  return new Date(Date.parse(iso) + 12 * 3_600_000).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}

function LimitsForm({ data, onSaved }: { data: CapacityReport; onSaved: (d: CapacityReport) => void }) {
  const [values, setValues] = useState<Record<CapacityMetric, string>>(() => ({
    streams: data.limits.streams?.toString() ?? '',
    mbps: data.limits.mbps?.toString() ?? '',
    transcodes: data.limits.transcodes?.toString() ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await api<CapacityReport>('/api/server/capacity', { method: 'POST', body: values }));
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError || err instanceof Error ? err.message : 'Couldn’t save.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold">Limits</h2>
      <p className="mt-0.5 text-sm text-ink-muted">What your servers can handle. Leave any you don’t know empty.</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {CAPACITY_METRICS.map((c) => (
          <label key={c.key} className="block text-sm">
            <span className="font-medium">{c.limitLabel}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={values[c.key]}
              onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
              className={`${input} mt-1`}
            />
            <span className="mt-1 block text-xs text-ink-faint">{c.limitHelp}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className={primary}>
          Save limits
        </button>
        {message && <span className={`text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</span>}
        {data.updatedAt && !message && (
          <span className="text-xs text-ink-faint">
            Last changed {formatWhen(data.updatedAt)}
            {data.updatedBy ? ` by ${data.updatedBy}` : ''}
          </span>
        )}
      </div>
    </form>
  );
}
