import { geoEqualEarth, geoPath } from 'd3-geo';
import { useMemo, useState } from 'react';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import countries110m from 'world-atlas/countries-110m.json';
import type { GeoCity, GeoCountry } from '../../../../shared/geo';
import { NUMERIC_BY_ALPHA2 } from '../../lib/countryCodes';
import { useWidth } from './useWidth';

import { countryName } from '../../lib/countryNames';

/** World shapes, minus Antarctica (nobody streams from there, and it takes a lot of room). */
const SHAPES = (() => {
  const topo = countries110m as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const all = feature(topo, topo.objects.countries);
  return { ...all, features: all.features.filter((f) => f.id !== '010') };
})();

interface Hover {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

/**
 * Countries shaded by how many people watched from them (one hue, faint to
 * strong), with optional city dots sized by viewers.
 */
export default function WorldMap({ countries, cities }: { countries: GeoCountry[]; cities: GeoCity[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const height = Math.max(220, Math.round(width * 0.48));

  const { path, projection } = useMemo(() => {
    const projection = geoEqualEarth().fitSize([Math.max(1, width), height], SHAPES);
    return { projection, path: geoPath(projection) };
  }, [width, height]);

  const byNumeric = useMemo(() => {
    const m = new Map<string, GeoCountry>();
    for (const c of countries) {
      const n = NUMERIC_BY_ALPHA2[c.code];
      if (n) m.set(n, c);
    }
    return m;
  }, [countries]);
  const maxViewers = Math.max(1, ...countries.map((c) => c.viewers));
  const maxCity = Math.max(1, ...cities.map((c) => c.viewers));
  const shade = (v: number) => 0.15 + 0.85 * Math.sqrt(v / maxViewers);

  const show = (e: React.PointerEvent, title: string, lines: string[]) => {
    const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    setHover({ x: e.clientX - box.left, y: e.clientY - box.top, title, lines });
  };
  const counts = (viewers: number, plays: number) => [`${viewers.toLocaleString()} ${viewers === 1 ? 'viewer' : 'viewers'}`, `${plays.toLocaleString()} plays`];

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Map of where people watch from. The list beside it has the same numbers." className="block">
          {SHAPES.features.map((f) => {
            const c = byNumeric.get(String(f.id));
            return (
              <path
                key={String(f.id ?? f.properties.name)}
                d={path(f) ?? undefined}
                fill={c ? 'var(--color-accent)' : 'var(--color-panel-raised)'}
                fillOpacity={c ? shade(c.viewers) : 1}
                stroke="var(--color-canvas)"
                strokeWidth={0.6}
                onPointerMove={(e) => show(e, c ? countryName(c.code) : f.properties.name, c ? counts(c.viewers, c.plays) : ['Nobody yet'])}
              />
            );
          })}
          {cities.map((c) => {
            const point = projection([c.lon, c.lat]);
            if (!point) return null;
            return (
              <circle
                key={`${c.country}:${c.city}`}
                cx={point[0]}
                cy={point[1]}
                r={2 + 9 * Math.sqrt(c.viewers / maxCity)}
                fill="var(--color-ink)"
                fillOpacity={0.85}
                stroke="var(--color-canvas)"
                strokeWidth={1.5}
                onPointerMove={(e) => show(e, c.city, [[c.region, countryName(c.country)].filter(Boolean).join(', '), ...counts(c.viewers, c.plays)])}
              />
            );
          })}
        </svg>
      )}
      {hover && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 rounded-lg border border-line bg-panel-raised px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(hover.x + 12, Math.max(0, width - 190)), top: Math.max(0, hover.y - 10) }}
        >
          <p className="font-semibold text-ink">{hover.title}</p>
          {hover.lines.map((l) => (
            <p key={l} className="text-ink-muted">
              {l}
            </p>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-end gap-2 text-[11px] text-ink-faint">
        Fewer viewers
        <span className="flex gap-[2px]" aria-hidden="true">
          {[0.15, 0.4, 0.65, 1].map((o) => (
            <span key={o} className="h-3 w-5 rounded-[2px] bg-panel-raised">
              <span className="block h-full w-full rounded-[2px] bg-accent" style={{ opacity: o }} />
            </span>
          ))}
        </span>
        More
        {cities.length > 0 && <span className="ml-3 flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-ink/85" aria-hidden="true" /> city (admins only)</span>}
      </div>
    </div>
  );
}
