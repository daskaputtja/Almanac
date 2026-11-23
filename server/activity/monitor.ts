import type { ActivitySnapshot } from '../../shared/activity.js';
import type { SessionSource } from '../silo/client.js';
import { summarize, toActivityStream } from './map.js';

type Listener = (snapshot: ActivitySnapshot) => void;

/**
 * Polls Silo for live sessions and keeps the latest snapshot in memory.
 * Browsers subscribe to updates over server-sent events.
 */
export class ActivityMonitor {
  private snapshot: ActivitySnapshot = {
    streams: [],
    summary: summarize([]),
    fetchedAt: null,
    error: null,
  };
  private readonly listeners = new Set<Listener>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly source: SessionSource,
    private readonly intervalMs: number,
    private readonly log: (message: string) => void = console.log,
  ) {}

  current(): ActivitySnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Fetch once and notify listeners. Exposed for tests. */
  async poll(): Promise<void> {
    try {
      const sessions = await this.source.listSessions();
      const streams = sessions
        .map(toActivityStream)
        .sort((a, b) => b.progress.startedAt.localeCompare(a.progress.startedAt));
      if (this.snapshot.error) this.log('Reconnected to Silo.');
      this.snapshot = {
        streams,
        summary: summarize(streams),
        fetchedAt: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.snapshot.error) this.log(`Activity poll failed: ${message}`);
      // Keep the last good streams so the dashboard doesn't go blank on a blip.
      this.snapshot = { ...this.snapshot, error: message };
    }

    for (const listener of this.listeners) listener(this.snapshot);
  }

  private async tick(): Promise<void> {
    await this.poll();
    if (this.running) this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }
}
