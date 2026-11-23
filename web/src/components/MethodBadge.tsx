import type { PlayMethod } from '../../../shared/activity';
import { PLAY_METHOD_LABELS } from '../lib/format';

export const METHOD_STYLES: Record<PlayMethod, { text: string; bg: string; dot: string }> = {
  direct: { text: 'text-direct', bg: 'bg-direct/12', dot: 'bg-direct' },
  direct_stream: { text: 'text-stream', bg: 'bg-stream/12', dot: 'bg-stream' },
  remux: { text: 'text-remux', bg: 'bg-remux/12', dot: 'bg-remux' },
  transcode: { text: 'text-transcode', bg: 'bg-transcode/12', dot: 'bg-transcode' },
};

export function MethodBadge({ method }: { method: PlayMethod }) {
  const style = METHOD_STYLES[method];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-px font-medium ${style.text} ${style.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
      {PLAY_METHOD_LABELS[method]}
    </span>
  );
}
