import { useState } from 'react';
import { niceTicks } from '../../lib/statsData';
import { Legend } from './StackedBars';
import { useWidth } from './useWidth';

export interface LineSeries<K extends string> {
  key: K;
  label: string;
  color: string;
  /** Shade the area under this line. */
  fill?: boolean;
  dashed?: boolean;
}

export interface LinePoint<K extends string> {
  /** Milliseconds since the epoch. */
  t: number;
  /** A series without a value at a point is not drawn there (for example a forecast that starts today). */
  values: Partial<Record<K, number>>;
}

interface Props<K extends string> {
  series: LineSeries<K>[];
  points: LinePoint<K>[];
  label: string;
  height?: number;
  formatValue?: (v: number) => string;
  formatTime: (t: number) => string;
  formatAxisTime: (t: number) => string;
}

const MARGIN = { top: 8, right: 8, bottom: 26, left: 48 };

/**
 * Lines over time on one axis, with a crosshair that snaps to the nearest
 * point and one tooltip listing every series.
 */
export function LineChart<K extends string>({
  series,
  points,
  label,
  height = 240,
  formatValue = (v) => v.toLocaleString(),
  formatTime,
  formatAxisTime,
}: Props<K>) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const maxValue = Math.max(0, ...points.flatMap((p) => series.map((s) => p.values[s.key] ?? 0)));
  const ticks = niceTicks(maxValue);
  const top = ticks[ticks.length - 1]!;
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? 1;
  const x = (t: number) => MARGIN.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => MARGIN.top + innerH - (v / top) * innerH;

  const path = (key: K) => {
    let pen = 'M';
    let out = '';
    for (const p of points) {
      const v = p.values[key];
      if (v === undefined) {
        pen = 'M';
        continue;
      }
      out += `${pen}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = 'L';
    }
    return out;
  };
  const labelCount = Math.max(2, Math.floor(innerW / 110));
  // With only a few points, label the points themselves; never repeat a label.
  const labelTimes = (
    points.length <= labelCount ? points.map((p) => p.t) : Array.from({ length: labelCount }, (_, i) => t0 + ((t1 - t0) * i) / (labelCount - 1))
  ).filter((t, i, all) => i === 0 || formatAxisTime(t) !== formatAxisTime(all[i - 1]!));

  const nearest = (clientX: number, rect: DOMRect) => {
    if (!points.length) return null;
    const t = t0 + ((clientX - rect.left - MARGIN.left) / innerW) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
    return best;
  };

  const activePoint = active != null ? points[active] : null;

  return (
    <div>
      <div className="mb-2">
        <Legend series={series} />
      </div>
      <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${label}. Use the left and right arrow keys to read the values.`}
            tabIndex={0}
            className="block rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onPointerMove={(e) => setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
            onKeyDown={(e) => {
              if (!points.length) return;
              if (e.key === 'ArrowRight') setActive((a) => Math.min(points.length - 1, (a ?? -1) + 1));
              else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? points.length) - 1));
              else if (e.key === 'Escape') setActive(null);
              else return;
              e.preventDefault();
            }}
            onBlur={() => setActive(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" />
                <text x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-faint text-[11px] tabular-nums">
                  {formatValue(t)}
                </text>
              </g>
            ))}
            {labelTimes.map((t, i) => (
              <text
                key={i}
                x={x(t)}
                y={height - 8}
                textAnchor={i === 0 ? 'start' : i === labelTimes.length - 1 ? 'end' : 'middle'}
                className="fill-ink-faint text-[11px]"
              >
                {formatAxisTime(t)}
              </text>
            ))}
            {series
              .filter((s) => s.fill && points.length > 1)
              .map((s) => (
                <path
                  key={`${s.key}-fill`}
                  d={`${path(s.key)}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`}
                  fill={s.color}
                  opacity={0.12}
                />
              ))}
            {series.map((s) => (
              <path
                key={s.key}
                d={path(s.key)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? '4 4' : undefined}
              />
            ))}
            <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} stroke="var(--color-ink-faint)" />
            {activePoint && (
              <g>
                <line x1={x(activePoint.t)} x2={x(activePoint.t)} y1={MARGIN.top} y2={y(0)} stroke="var(--color-ink-muted)" strokeWidth={1} />
                {series.filter((s) => activePoint.values[s.key] !== undefined).map((s) => (
                  <circle
                    key={s.key}
                    cx={x(activePoint.t)}
                    cy={y(activePoint.values[s.key] ?? 0)}
                    r={4}
                    fill={s.color}
                    stroke="var(--color-panel)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            )}
          </svg>
        )}
        {activePoint && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-lg border border-line bg-panel-raised px-3 py-2 text-xs shadow-lg"
            style={{ left: Math.min(Math.max(x(activePoint.t), 100), width - 100), transform: 'translateX(-50%)' }}
          >
            <p className="mb-1.5 font-medium text-ink-muted">{formatTime(activePoint.t)}</p>
            <ul className="space-y-1">
              {series.filter((s) => activePoint.values[s.key] !== undefined).map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden="true" />
                  <span className="font-semibold tabular-nums text-ink">{formatValue(activePoint.values[s.key] ?? 0)}</span>
                  <span className="text-ink-muted">{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
