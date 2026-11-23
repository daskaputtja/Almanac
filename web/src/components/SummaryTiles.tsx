import type { ActivitySummary, PlayMethod } from '../../../shared/activity';
import { PLAY_METHOD_LABELS, formatBitrate } from '../lib/format';
import { METHOD_STYLES } from './MethodBadge';

const METHODS: PlayMethod[] = ['direct', 'direct_stream', 'remux', 'transcode'];

export function SummaryTiles({ summary }: { summary: ActivitySummary }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Tile label="Streams">
        <p className="text-3xl font-semibold tabular-nums">{summary.total}</p>
        <p className="mt-1 text-sm text-ink-muted">
          {summary.playing} playing · {summary.paused} paused
        </p>
      </Tile>

      <Tile label="Playback">
        <MethodBar summary={summary} />
        <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-sm">
          {METHODS.map((method) => (
            <li key={method} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${METHOD_STYLES[method].dot}`} aria-hidden="true" />
              <span className="text-ink-muted">{PLAY_METHOD_LABELS[method]}</span>
              <span className="ml-auto tabular-nums">{summary.byMethod[method]}</span>
            </li>
          ))}
        </ul>
      </Tile>

      <Tile label="Bandwidth">
        <p className="text-3xl font-semibold tabular-nums">{formatBitrate(summary.bandwidthKbps)}</p>
        <p className="mt-1 text-sm text-ink-muted">
          {summary.local} local · {summary.remote} remote
        </p>
      </Tile>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-faint">{label}</h2>
      {children}
    </section>
  );
}

function MethodBar({ summary }: { summary: ActivitySummary }) {
  if (!summary.total) return <div className="h-2 rounded-full bg-panel-raised" />;
  return (
    <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
      {METHODS.filter((m) => summary.byMethod[m] > 0).map((method) => (
        <div
          key={method}
          className={METHOD_STYLES[method].dot}
          style={{ width: `${(summary.byMethod[method] / summary.total) * 100}%` }}
        />
      ))}
    </div>
  );
}
