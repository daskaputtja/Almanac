import { Suspense, lazy, useEffect, useState } from 'react';
import type { GeoResponse } from '../../../shared/geo';
import { api } from '../lib/api';
import { countryName } from '../lib/countryNames';

// The map and its world shapes are loaded only when a map is shown.
const WorldMap = lazy(() => import('./charts/WorldMap'));
import { PERIODS, SHORT_PLAY_SECONDS } from './StatsSections';

/** A flag emoji from a country code ("GB" → 🇬🇧). */
const flag = (code: string) => (/^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

/** "Where people watch": the map plus top countries (and cities for admins). */
export function WhereSection({ period, userId, title = 'Where people watch' }: { period: string; userId: string | null; title?: string }) {
  const [data, setData] = useState<GeoResponse | null>(null);

  useEffect(() => {
    const days = PERIODS[period]?.days;
    const q = new URLSearchParams({ minWatched: String(SHORT_PLAY_SECONDS) });
    if (days) {
      const d = new Date(Date.now() - days * 86_400_000);
      d.setMinutes(0, 0, 0);
      q.set('from', d.toISOString());
    }
    if (userId) q.set('user', userId);
    api<GeoResponse>(`/api/stats/map?${q}`).then(setData).catch(() => {});
  }, [period, userId]);

  if (!data) return null;
  const top = data.countries.slice(0, 12);
  const maxViewers = Math.max(1, ...top.map((c) => c.viewers));

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {!data.ready ? (
        <p className="py-10 text-center text-sm text-ink-muted">
          Almanac is downloading its location database (a one-off, about 65 MB). The map appears within a few minutes.
        </p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[3fr_1fr]">
          <Suspense fallback={<div className="aspect-[2/1] rounded-lg bg-panel-raised/40" />}>
            <WorldMap countries={data.countries} cities={data.cities} />
          </Suspense>
          <div className="space-y-4">
            <ol className="space-y-2">
              {top.map((c) => (
                <li key={c.code}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate">
                      <span aria-hidden="true">{flag(c.code)} </span>
                      {countryName(c.code)}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {c.viewers.toLocaleString()} <span className="text-xs text-ink-faint">{c.viewers === 1 ? 'viewer' : 'viewers'}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-panel-raised">
                    <div className="h-full rounded-full bg-accent-dim" style={{ width: `${(c.viewers / maxViewers) * 100}%` }} />
                  </div>
                </li>
              ))}
              {top.length === 0 && <li className="text-sm text-ink-faint">No located plays in this period yet.</li>}
            </ol>
            {data.cities.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-ink-faint">Top cities</h3>
                <ol className="space-y-1 text-sm">
                  {data.cities.slice(0, 6).map((c) => (
                    <li key={`${c.country}:${c.city}`} className="flex justify-between gap-2">
                      <span className="truncate">
                        {c.city}
                        <span className="text-ink-faint"> · {c.country}</span>
                      </span>
                      <span className="tabular-nums text-ink-muted">{c.viewers.toLocaleString()}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      )}
      <p className="mt-3 text-[11px] text-ink-faint">
        {data.local > 0 && `${data.local.toLocaleString()} plays from home networks. `}
        {data.unknown > 0 && `${data.unknown.toLocaleString()} plays not located yet. `}
        Located on this server with{' '}
        <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="underline hover:text-ink-muted">
          IP geolocation by DB-IP
        </a>{' '}
        (CC BY 4.0){data.dataDate && `, data from ${new Date(data.dataDate).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}. Addresses are never sent anywhere.
      </p>
    </section>
  );
}
