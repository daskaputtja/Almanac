import { useState } from 'react';
import { niceTicks } from '../../lib/statsData';
import { useWidth } from './useWidth';

export interface Series<K extends string> {
  key: K;
  label: string;
  color: string;
}

export interface Bar<K extends string> {
  id: string;
  /** Short axis label, e.g. "17 Nov". */
  label: string;
  /** Longer tooltip heading, e.g. "Monday 17 November". */
  title: string;
  values: Record<K, number>;
}

interface Props<K extends string> {
  series: Series<K>[];
  bars: Bar<K>[];
  height?: number;
  /** Accessible name for the chart. */
  label: string;
  /** Formats the axis labels. The tooltip always shows exact values. */
  formatValue?: (value: number) => string;
}

const MARGIN = { top: 8, right: 4, bottom: 26, left: 44 };
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4;

/**
 * Vertical stacked bars with a shared tooltip. Series stack bottom-up in the
 * order given; hovering or arrowing to a bar lists every series' value.
 */
export function StackedBars<K extends string>({
  series,
  bars,
  height = 260,
  label,
  formatValue = (v) => v.toLocaleString(),
}: Props<K>) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const totals = bars.map((b) => series.reduce((sum, s) => sum + (b.values[s.key] ?? 0), 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const max = ticks[ticks.length - 1]!;
  const band = bars.length ? innerW / bars.length : 0;
  const barW = Math.max(1, Math.min(28, band * 0.72));
  const y = (v: number) => MARGIN.top + innerH - (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(innerW / 72))));

  const move = (delta: number) =>
    setActive((current) => Math.min(bars.length - 1, Math.max(0, (current ?? (delta > 0 ? -1 : bars.length)) + delta)));

  const activeBar = active != null ? bars[active] : null;
  const tooltipLeft = active != null ? MARGIN.left + band * (active + 0.5) : 0;

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${label}. Use the left and right arrow keys to read each bar.`}
          tabIndex={0}
          className="block rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') move(1);
            else if (e.key === 'ArrowLeft') move(-1);
            else if (e.key === 'Escape') setActive(null);
            else return;
            e.preventDefault();
          }}
          onBlur={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-faint text-[11px] tabular-nums">
                {formatValue(t)}
              </text>
            </g>
          ))}

          {bars.map((bar, i) => {
            const cx = MARGIN.left + band * (i + 0.5);
            const x = cx - barW / 2;
            let base = 0;
            const visible = series.filter((s) => (bar.values[s.key] ?? 0) > 0);
            const dim = active != null && active !== i;
            return (
              <g key={bar.id} opacity={dim ? 0.45 : 1}>
                {visible.map((s, si) => {
                  const value = bar.values[s.key] ?? 0;
                  const top = y(base + value);
                  const bottom = y(base);
                  base += value;
                  const isTop = si === visible.length - 1;
                  // Leave a surface-coloured gap above each segment except the top one.
                  const h = Math.max(0, bottom - top - (isTop ? 0 : GAP));
                  if (h <= 0) return null;
                  const segTop = isTop ? top : top + GAP;
                  if (isTop && barW >= 6 && h > RADIUS) {
                    const r = Math.min(RADIUS, barW / 2);
                    const yb = segTop + h;
                    return (
                      <path
                        key={s.key}
                        fill={s.color}
                        d={`M${x},${yb} V${segTop + r} Q${x},${segTop} ${x + r},${segTop} H${x + barW - r} Q${x + barW},${segTop} ${x + barW},${segTop + r} V${yb} Z`}
                      />
                    );
                  }
                  return <rect key={s.key} x={x} y={segTop} width={barW} height={h} fill={s.color} />;
                })}
                {i % labelEvery === 0 && (
                  <text x={cx} y={height - 8} textAnchor="middle" className="fill-ink-faint text-[11px]">
                    {bar.label}
                  </text>
                )}
                {/* Hit area: the whole column, wider than the bar. */}
                <rect
                  x={MARGIN.left + band * i}
                  y={MARGIN.top}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  onPointerEnter={() => setActive(i)}
                  onPointerMove={() => setActive(i)}
                />
              </g>
            );
          })}

          <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} stroke="var(--color-ink-faint)" strokeWidth={1} />
        </svg>
      )}

      {activeBar && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-lg border border-line bg-panel-raised px-3 py-2 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(tooltipLeft, 90), width - 90),
            transform: 'translateX(-50%)',
          }}
        >
          <p className="mb-1.5 font-medium text-ink-muted">{activeBar.title}</p>
          <ul className="space-y-1">
            {[...series].reverse().map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden="true" />
                <span className="font-semibold tabular-nums text-ink">{(activeBar.values[s.key] ?? 0).toLocaleString()}</span>
                <span className="text-ink-muted">{s.label}</span>
              </li>
            ))}
            <li className="flex items-center gap-2 border-t border-line pt-1">
              <span className="w-3" aria-hidden="true" />
              <span className="font-semibold tabular-nums text-ink">
                {series.reduce((sum, s) => sum + (activeBar.values[s.key] ?? 0), 0).toLocaleString()}
              </span>
              <span className="text-ink-muted">Total</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

export function Legend<K extends string>({ series }: { series: Series<K>[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
