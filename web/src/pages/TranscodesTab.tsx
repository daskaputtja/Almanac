import { useEffect, useState } from 'react';
import type { TranscodeReport, TranscodeSuggestion } from '../../../shared/transcodes';
import { METHOD_STYLES } from '../components/MethodBadge';
import { Stat } from '../components/StatsSections';
import { api } from '../lib/api';
import { PLAY_METHOD_LABELS, platformLabel, reasonLabel } from '../lib/format';

const IMPACT: Record<TranscodeSuggestion['impact'], string> = { high: 'Big win', medium: 'Worth doing', low: 'Small' };

/** What causes transcodes, and what to do about it. */
export function TranscodesTab() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<TranscodeReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<TranscodeReport>(`/api/server/transcodes?days=${days}`)
      .then((d) => !cancelled && setData(d))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [days]);

  if (!data) return <p className="py-16 text-center text-sm text-ink-muted">Loading…</p>;
  const p = data.plays;
  const rate = p.total ? (p.transcode / p.total) * 100 : 0;
  const breakdown: [keyof typeof METHOD_STYLES, number][] = [
    ['direct', p.direct],
    ['direct_stream', p.directStream],
    ['remux', p.remux],
    ['transcode', p.transcode],
  ];
  const maxPlayer = Math.max(1, ...data.players.map((x) => x.transcodes));
  const maxReason = Math.max(1, ...data.reasons.map((x) => x.streams));

  return (
    <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Period">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={d === days}
              onClick={() => setDays(d)}
              className={`rounded-md px-3 py-1.5 text-sm ${d === days ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              {d} days
            </button>
          ))}
        </div>
        {data.observedSince && (
          <p className="text-xs text-ink-faint">
            Reasons, sources and files come from streams Almanac has watched since{' '}
            {new Date(data.observedSince).toLocaleDateString(undefined, { dateStyle: 'medium' })} ({data.observed.toLocaleString()} streams). Silo’s
            history doesn’t record them.
          </p>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_2fr]">
        <Stat label="Transcoded" value={`${rate.toFixed(1)}%`} detail={`${p.transcode.toLocaleString()} of ${p.total.toLocaleString()} plays`} />
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-faint">How plays were delivered</h2>
          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {breakdown
              .filter(([, n]) => n > 0)
              .map(([m, n]) => (
                <div key={m} className={METHOD_STYLES[m].dot} style={{ width: `${(n / Math.max(1, p.total)) * 100}%` }} />
              ))}
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-4">
            {breakdown.map(([m, n]) => (
              <li key={m} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${METHOD_STYLES[m].dot}`} aria-hidden="true" />
                <span className="text-ink-muted">{PLAY_METHOD_LABELS[m]}</span>
                <span className="ml-auto tabular-nums">{n.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">What to do about it</h2>
        {data.convertedObserved < data.minimumForSuggestions && (
          <p className="text-sm text-ink-muted">
            {`Suggestions about reasons and files appear once Almanac has seen ${data.minimumForSuggestions} converted streams (${data.convertedObserved} so far). On a busy server that takes a few hours.`}
          </p>
        )}
        {data.suggestions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-ink-muted">
            {data.convertedObserved < data.minimumForSuggestions
              ? 'No player stands out yet. More suggestions will follow as Almanac watches more streams.'
              : 'Nothing stands out: transcodes are spread thinly across many causes.'}
          </p>
        ) : (
          <ol className="space-y-2">
            {data.suggestions.map((s, i) => (
              <li key={i} className="rounded-xl border border-line bg-panel p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${
                      s.impact === 'high' ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink-muted'
                    }`}
                  >
                    {IMPACT[s.impact]}
                  </span>
                  <h3 className="font-semibold">{s.title}</h3>
                </div>
                <p className="mt-1 text-sm text-ink-muted">{s.detail}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">Players that transcode most</h2>
          {data.players.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">No transcodes in this period.</p>
          ) : (
            <ol className="space-y-2.5">
              {data.players.map((pl) => (
                <li key={`${pl.name}|${pl.platform}`}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate">
                      {pl.name}
                      {pl.platform && <span className="text-ink-faint"> · {platformLabel(pl.platform)}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <span className="font-medium">{pl.transcodes.toLocaleString()}</span>
                      <span className="ml-1.5 text-xs text-ink-faint">
                        {Math.round(pl.rate)}% of {pl.plays.toLocaleString()} plays
                      </span>
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-panel-raised">
                    <div className="h-full rounded-full bg-transcode" style={{ width: `${(pl.transcodes / maxPlayer) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">Why streams were converted</h2>
          {data.reasons.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-faint">None recorded yet.</p>
          ) : (
            <ol className="space-y-2.5">
              {data.reasons.map((r) => (
                <li key={r.reason}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span>{reasonLabel(r.reason)}</span>
                    <span className="shrink-0 tabular-nums">
                      <span className="font-medium">{r.streams.toLocaleString()}</span>
                      <span className="ml-1.5 text-xs text-ink-faint">{Math.round(r.share)}%</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-panel-raised">
                    <div className="h-full rounded-full bg-accent-dim" style={{ width: `${(r.streams / maxReason) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-3 text-xs text-ink-faint">A stream can have more than one reason.</p>
        </section>
      </div>

      {data.sources.length > 0 && (
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 text-sm font-semibold">Source video that gets transcoded</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-faint">
              <tr>
                <th className="py-1.5 font-medium">Video</th>
                <th className="py-1.5 text-right font-medium">Streams</th>
                <th className="py-1.5 text-right font-medium">Transcoded</th>
                <th className="py-1.5 text-right font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.video} className="border-t border-line/60">
                  <td className="py-1.5">{s.video}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-muted">{s.streams.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.transcodes.toLocaleString()}</td>
                  <td className="py-1.5 text-right tabular-nums">{Math.round(s.rate)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data.files.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-line bg-panel">
          <h2 className="px-4 pt-4 text-sm font-semibold">Files transcoded most</h2>
          <p className="px-4 text-xs text-ink-faint">Re-encoding these, or adding a version that plays directly, avoids the most work.</p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs text-ink-faint">
                <tr>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Why</th>
                  <th className="px-4 py-2 text-right font-medium">Transcodes</th>
                  <th className="px-4 py-2 text-right font-medium">Viewers</th>
                </tr>
              </thead>
              <tbody>
                {data.files.map((f) => (
                  <tr key={f.fileId} className="border-t border-line/60">
                    <td className="max-w-[18rem] truncate px-4 py-2" title={f.title}>
                      {f.title}
                    </td>
                    <td className="px-4 py-2 text-ink-muted">{f.source}</td>
                    <td className="max-w-[16rem] truncate px-4 py-2 text-ink-muted" title={f.reasons.map(reasonLabel).join(', ')}>
                      {f.reasons.map(reasonLabel).join(', ') || '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{f.transcodes}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{f.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
