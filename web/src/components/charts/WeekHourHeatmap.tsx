import { useState } from 'react';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });
}

/**
 * Plays by weekday and hour in the viewer's time zone. One hue, faint for
 * few plays and bright for many (a sequential scale).
 */
export function WeekHourHeatmap({ grid, label }: { grid: number[][]; label: string }) {
  const [active, setActive] = useState<[number, number] | null>(null);
  const max = Math.max(1, ...grid.flat());
  const total = grid.flat().reduce((a, b) => a + b, 0);

  const move = (dDay: number, dHour: number) =>
    setActive((current) => {
      const [d, h] = current ?? [0, 0];
      return current ? [Math.min(6, Math.max(0, d + dDay)), Math.min(23, Math.max(0, h + dHour))] : [0, 0];
    });

  const shade = (value: number) => (value === 0 ? 0 : 0.12 + 0.88 * (value / max));
  const activeValue = active ? grid[active[0]]![active[1]]! : 0;

  return (
    <div>
      <div
        role="img"
        aria-label={`${label}. Use the arrow keys to read each hour.`}
        tabIndex={0}
        className="relative rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
          const m = moves[e.key];
          if (m) {
            move(m[0], m[1]);
            e.preventDefault();
          } else if (e.key === 'Escape') setActive(null);
        }}
      >
        <div className="grid grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-[2px]">
          {grid.map((row, day) => (
            <div key={day} className="contents">
              <div className="flex items-center pr-1 text-[11px] text-ink-faint">{DAYS[day]!.slice(0, 3)}</div>
              {row.map((value, hour) => {
                const isActive = active?.[0] === day && active[1] === hour;
                return (
                  <div
                    key={hour}
                    onPointerEnter={() => setActive([day, hour])}
                    className={`aspect-square min-h-3 rounded-[3px] bg-panel-raised ${isActive ? 'ring-2 ring-ink' : ''}`}
                  >
                    <div className="h-full w-full rounded-[3px] bg-accent" style={{ opacity: shade(value) }} />
                  </div>
                );
              })}
            </div>
          ))}
          <div />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="pt-1 text-center text-[10px] text-ink-faint">
              {hour % 3 === 0 ? hourLabel(hour) : ''}
            </div>
          ))}
        </div>

        {active && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 rounded-lg border border-line bg-panel-raised px-3 py-2 text-xs shadow-lg"
            style={{
              left: `calc(2.5rem + (100% - 2.5rem) * ${(active[1] + 0.5) / 24})`,
              top: `calc(${(active[0] / 7) * 100}% - 3.25rem)`,
              transform: 'translateX(-50%)',
            }}
          >
            <span className="font-semibold tabular-nums text-ink">{activeValue.toLocaleString()} plays</span>
            <span className="block text-ink-muted">
              {DAYS[active[0]]} {hourLabel(active[1])}–{hourLabel((active[1] + 1) % 24)}
              {total > 0 && ` · ${((activeValue / total) * 100).toFixed(1)}%`}
            </span>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-ink-faint">
        Fewer
        <span className="flex gap-[2px]" aria-hidden="true">
          {[0.12, 0.34, 0.56, 0.78, 1].map((o) => (
            <span key={o} className="h-3 w-3 rounded-[3px] bg-panel-raised">
              <span className="block h-full w-full rounded-[3px] bg-accent" style={{ opacity: o }} />
            </span>
          ))}
        </span>
        More
        <span className="ml-2">Busiest hour: {max.toLocaleString()} plays</span>
      </div>
    </div>
  );
}
