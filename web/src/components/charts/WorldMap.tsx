import { geoEqualEarth, geoPath } from 'd3-geo';
import { useMemo, useRef, useState } from 'react';
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

const MAX_ZOOM = 12;

/** Zoom level and pan offset, in screen pixels. */
interface View {
  k: number;
  x: number;
  y: number;
}

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
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const height = Math.max(220, Math.round(width * 0.48));

  // Keep the map covering the frame, so it can't be dragged off screen.
  const clampView = (v: View): View => ({
    k: v.k,
    x: Math.min(0, Math.max(width - width * v.k, v.x)),
    y: Math.min(0, Math.max(height - height * v.k, v.y)),
  });
  /** Zoom by a factor, keeping the point (cx, cy) in the same place on screen. */
  const zoomAt = (factor: number, cx = width / 2, cy = height / 2) =>
    setView((v) => {
      const k = Math.min(MAX_ZOOM, Math.max(1, v.k * factor));
      return clampView({ k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) });
    });

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
    if (drag.current?.moved) return;
    const box = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
    setHover({ x: e.clientX - box.left, y: e.clientY - box.top, title, lines });
  };
  const counts = (viewers: number, plays: number) => [`${viewers.toLocaleString()} ${viewers === 1 ? 'viewer' : 'viewers'}`, `${plays.toLocaleString()} plays`];

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Map of where people watch from. The list beside it has the same numbers."
          className={`block touch-none select-none ${view.k > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onDoubleClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            zoomAt(e.shiftKey ? 0.5 : 2, e.clientX - box.left, e.clientY - box.top);
          }}
          onPointerDown={(e) => {
            if (view.k === 1) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (!d.moved && Math.hypot(dx, dy) < 3) return;
            d.moved = true;
            d.x = e.clientX;
            d.y = e.clientY;
            setHover(null);
            setView((v) => clampView({ k: v.k, x: v.x + dx, y: v.y + dy }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
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
                vectorEffect="non-scaling-stroke"
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
                r={(2 + 9 * Math.sqrt(c.viewers / maxCity)) / view.k}
                fill="var(--color-ink)"
                fillOpacity={0.85}
                stroke="var(--color-canvas)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                onPointerMove={(e) => show(e, c.city, [[c.region, countryName(c.country)].filter(Boolean).join(', '), ...counts(c.viewers, c.plays)])}
              />
            );
          })}
          </g>
        </svg>
      )}
      {width > 0 && (
        <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-lg border border-line bg-panel-raised/90 text-ink shadow-lg">
          <ZoomButton label="Zoom in" disabled={view.k >= MAX_ZOOM} onClick={() => zoomAt(2)}>
            <path d="M8 3.5v9M3.5 8h9" />
          </ZoomButton>
          <ZoomButton label="Zoom out" disabled={view.k <= 1} onClick={() => zoomAt(0.5)}>
            <path d="M3.5 8h9" />
          </ZoomButton>
          {view.k > 1 && (
            <ZoomButton label="Show the whole world" onClick={() => setView({ k: 1, x: 0, y: 0 })}>
              <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
            </ZoomButton>
          )}
        </div>
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
        <span className="mr-auto hidden sm:inline">{view.k > 1 ? 'Drag to move around' : 'Double-click to zoom in'}</span>
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

function ZoomButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center border-b border-line last:border-b-0 hover:bg-panel hover:text-accent disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}
