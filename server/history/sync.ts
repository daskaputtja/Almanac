import type { HistorySyncStatus } from '../../shared/history.js';
import { type HistorySource, SiloError } from '../silo/client.js';
import type { HistoryStore } from './store.js';

const STATE = {
  importDone: 'import_done',
  importCursor: 'import_cursor',
  importCount: 'import_count',
  importStartedAt: 'import_started_at',
  importFinishedAt: 'import_finished_at',
  lastSyncAt: 'last_sync_at',
} as const;

/** Re-read plays that ended this long before our newest one, in case Silo finalised them late. */
const OVERLAP_MS = 10 * 60 * 1000;
/** During the first import, check for new plays at least this often. */
const IMPORT_SLICE_MS = 30 * 1000;

export interface HistorySyncOptions {
  intervalMs: number;
  /** Pause between import pages so the import doesn't hammer Silo. */
  pageDelayMs?: number;
  log?: (message: string) => void;
}

/**
 * Copies Silo's playback history into Almanac's database.
 *
 * The first time it runs, it imports all of Silo's existing history, newest
 * first, saving its place after every page so a restart carries on where it
 * stopped. After that it fetches only plays that ended since the newest one
 * it has, every `intervalMs` or sooner when `trigger()` is called.
 */
export class HistorySync {
  private running = false;
  private wake: (() => void) | null = null;
  private triggerTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private readonly pageDelayMs: number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly store: HistoryStore,
    private readonly source: HistorySource,
    private readonly options: HistorySyncOptions,
  ) {
    this.pageDelayMs = options.pageDelayMs ?? 250;
    this.log = options.log ?? console.log;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.triggerTimer) clearTimeout(this.triggerTimer);
    this.wake?.();
  }

  /** Ask for a sync soon, e.g. because a stream just ended. Repeated calls are merged. */
  trigger(delayMs = 5000): void {
    if (this.triggerTimer) return;
    this.triggerTimer = setTimeout(() => {
      this.triggerTimer = null;
      this.wake?.();
    }, delayMs);
  }

  status(): HistorySyncStatus {
    const { total, oldest, newest } = this.store.stats();
    return {
      totalPlays: total,
      oldestPlayAt: oldest,
      newestPlayAt: newest,
      import: {
        done: this.store.getState(STATE.importDone) === '1',
        imported: Number(this.store.getState(STATE.importCount) ?? 0),
        startedAt: this.store.getState(STATE.importStartedAt),
        finishedAt: this.store.getState(STATE.importFinishedAt),
      },
      lastSyncAt: this.store.getState(STATE.lastSyncAt),
      lastError: this.lastError,
    };
  }

  /** Fetch new plays, then continue the first-time import for up to `importBudgetMs`. */
  async syncOnce(importBudgetMs = IMPORT_SLICE_MS): Promise<void> {
    try {
      await this.syncRecent();
      const deadline = Date.now() + importBudgetMs;
      while (!this.importDone() && Date.now() < deadline && (this.running || importBudgetMs === Infinity)) {
        await this.importPage();
        if (this.pageDelayMs) await sleep(this.pageDelayMs);
      }
      if (this.lastError) this.log('History sync recovered.');
      this.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.lastError) this.log(`History sync failed: ${message}`);
      this.lastError = message;
    }
  }

  private importDone(): boolean {
    return this.store.getState(STATE.importDone) === '1';
  }

  /** Fetch every play that ended since (a little before) the newest one stored. */
  private async syncRecent(): Promise<void> {
    const { newest } = this.store.stats();
    if (!newest) {
      // Nothing stored yet: the import will fetch the newest plays first anyway.
      if (this.importDone()) await this.walk(undefined);
      return;
    }
    const endedAfter = new Date(Date.parse(newest) - OVERLAP_MS).toISOString();
    await this.walk(endedAfter);
  }

  private async walk(endedAfter: string | undefined): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const result = await this.source.listHistoryPage({ endedAfter, cursor });
      this.store.upsert(result.items);
      cursor = result.page?.has_more ? result.page.next_cursor : undefined;
      if (!cursor) break;
    }
    this.store.setState(STATE.lastSyncAt, new Date().toISOString());
  }

  /** Import one page of older history, remembering where we got to. */
  private async importPage(): Promise<void> {
    if (!this.store.getState(STATE.importStartedAt)) {
      this.store.setState(STATE.importStartedAt, new Date().toISOString());
      this.log('Importing play history from Silo. This can take a while the first time.');
    }

    const cursor = this.store.getState(STATE.importCursor) ?? undefined;
    let result;
    try {
      result = await this.source.listHistoryPage({ cursor });
    } catch (err) {
      if (cursor && err instanceof SiloError && err.status === 400) {
        // The saved cursor is no longer valid (for example after a Silo upgrade).
        // Start the walk again; plays already stored are simply updated.
        this.log('Saved import position was rejected by Silo; restarting the import from the newest play.');
        this.store.setState(STATE.importCursor, null);
        return;
      }
      throw err;
    }

    this.store.upsert(result.items);
    const imported = Number(this.store.getState(STATE.importCount) ?? 0) + result.items.length;
    this.store.setState(STATE.importCount, String(imported));

    const next = result.page?.has_more ? result.page.next_cursor : undefined;
    if (next) {
      this.store.setState(STATE.importCursor, next);
      if (imported % 10_000 < result.items.length) this.log(`Imported ${imported.toLocaleString('en')} plays so far…`);
    } else {
      this.store.setState(STATE.importCursor, null);
      this.store.setState(STATE.importDone, '1');
      this.store.setState(STATE.importFinishedAt, new Date().toISOString());
      this.log(`Finished importing play history: ${imported.toLocaleString('en')} plays.`);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.syncOnce();
      if (!this.running) break;
      // Keep importing without a pause until the first import is finished.
      if (!this.importDone() && !this.lastError) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
