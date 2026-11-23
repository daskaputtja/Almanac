import type { PlayMethod } from '../../../shared/activity';
import { PLAY_METHOD_LABELS } from '../lib/format';

/** Tailwind classes per method. `color` is the raw CSS variable, for SVG fills. */
export const METHOD_STYLES: Record<PlayMethod, { bg: string; dot: string; color: string }> = {
  direct: { bg: 'bg-direct/15', dot: 'bg-direct', color: 'var(--color-direct)' },
  direct_stream: { bg: 'bg-stream/15', dot: 'bg-stream', color: 'var(--color-stream)' },
  remux: { bg: 'bg-remux/15', dot: 'bg-remux', color: 'var(--color-remux)' },
  transcode: { bg: 'bg-transcode/15', dot: 'bg-transcode', color: 'var(--color-transcode)' },
};

export function MethodBadge({ method }: { method: PlayMethod }) {
  const style = METHOD_STYLES[method];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-1.5 py-px font-medium text-ink ${style.bg}`}>
      <span className={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
      {PLAY_METHOD_LABELS[method]}
    </span>
  );
}
