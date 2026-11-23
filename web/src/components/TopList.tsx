import type { StatsRankBy, TopEntry } from '../../../shared/stats';
import { formatHours } from '../lib/statsData';

interface Props {
  title: string;
  entries: TopEntry[];
  rankBy: StatsRankBy;
  formatName?: (entry: TopEntry) => string;
  emptyText?: string;
}

/** A ranked top-N list with one bar per entry, all in one colour. */
export function TopList({ title, entries, rankBy, formatName = (e) => e.name, emptyText = 'Nothing yet' }: Props) {
  const metric = (e: TopEntry) => (rankBy === 'watched' ? e.watchedSeconds : e.plays);
  const max = Math.max(1, ...entries.map(metric));

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-faint">{emptyText}</p>
      ) : (
        <ol className="space-y-2.5">
          {entries.map((e, i) => {
            // Some players don't report watch time; say so instead of showing "0 min".
            const watched = e.watchedSeconds > 0 ? formatHours(e.watchedSeconds) : 'not measured';
            const primary = rankBy === 'watched' ? watched : `${e.plays.toLocaleString()} plays`;
            const secondary = rankBy === 'watched' ? `${e.plays.toLocaleString()} plays` : watched;
            return (
              <li key={e.key} className="grid grid-cols-[1.25rem_1fr] gap-x-2">
                <span className="pt-px text-right text-xs tabular-nums text-ink-faint">{i + 1}</span>
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate" title={formatName(e)}>
                        {formatName(e)}
                      </span>
                      {e.detail && <span className="block truncate text-xs text-ink-faint">{e.detail}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <span className="font-medium text-ink">{primary}</span>
                      <span className="ml-1.5 text-xs text-ink-faint">{secondary}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-panel-raised">
                    <div className="h-full rounded-full bg-harvest-dim" style={{ width: `${(metric(e) / max) * 100}%` }} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
