import { useEffect, useState } from 'react';
import type { ActivitySnapshot } from '../../../shared/activity';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export interface ActivityState {
  snapshot: ActivitySnapshot | null;
  /** Browser time when the snapshot arrived, for smooth progress bars. */
  receivedAt: number;
  connection: ConnectionState;
}

/** Subscribe to live activity from the Almanac server over server-sent events. */
export function useActivity(): ActivityState {
  const [state, setState] = useState<ActivityState>({
    snapshot: null,
    receivedAt: Date.now(),
    connection: 'connecting',
  });

  useEffect(() => {
    const source = new EventSource('/api/activity/stream');

    source.addEventListener('activity', (event) => {
      const snapshot = JSON.parse((event as MessageEvent<string>).data) as ActivitySnapshot;
      setState({ snapshot, receivedAt: Date.now(), connection: 'live' });
    });

    source.addEventListener('error', () => {
      // EventSource retries on its own; just show that we're out of date.
      setState((prev) => ({ ...prev, connection: prev.snapshot ? 'reconnecting' : 'connecting' }));
    });

    return () => source.close();
  }, []);

  return state;
}

/** Re-render every `intervalMs` so time-based values keep moving. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
