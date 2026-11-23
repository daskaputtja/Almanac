import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { HistorySync } from '../server/history/sync.js';
import { type HistorySource, SiloError } from '../server/silo/client.js';
import { MockHistorySource } from '../server/silo/mock.js';
import type { HistoryPageQuery, SiloHistoryEntry } from '../server/silo/types.js';

const quiet = () => {};

function setup(source: HistorySource) {
  const store = new HistoryStore(openDatabase(':memory:'));
  const sync = new HistorySync(store, source, { intervalMs: 60_000, pageDelayMs: 0, log: quiet });
  return { store, sync };
}

/** Wraps the mock so tests can add plays and count requests. */
class TestSource implements HistorySource {
  readonly extra: SiloHistoryEntry[] = [];
  readonly calls: HistoryPageQuery[] = [];
  failNext: Error | null = null;
  constructor(private readonly mock: MockHistorySource) {}

  async listHistoryPage(query: HistoryPageQuery) {
    this.calls.push(query);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const page = await this.mock.listHistoryPage({ ...query, limit: 50 });
    if (!query.cursor) {
      const extra = this.extra.filter((e) => !query.endedAfter || e.ended_at >= query.endedAfter);
      return { ...page, items: [...extra, ...page.items] };
    }
    return page;
  }
}

describe('HistorySync', () => {
  it('imports all existing history', async () => {
    const { store, sync } = setup(new MockHistorySource(Date.now(), 230));
    await sync.syncOnce(Infinity);
    const status = sync.status();
    expect(status.totalPlays).toBe(230);
    expect(status.import.done).toBe(true);
    expect(status.import.finishedAt).not.toBeNull();
    expect(store.stats().total).toBe(230);
  });

  it('resumes the import from where it stopped', async () => {
    const mock = new MockHistorySource(Date.now(), 230);
    let pages = 0;
    let failing = true;
    const source: HistorySource = {
      listHistoryPage: async (q) => {
        if (failing && ++pages === 3) throw new Error('network down');
        return mock.listHistoryPage({ ...q, limit: 50 });
      },
    };
    const { store, sync } = setup(source);

    await sync.syncOnce(Infinity);
    expect(sync.status().lastError).toBe('network down');
    const partial = store.stats().total;
    expect(partial).toBe(100);

    failing = false;
    await sync.syncOnce(Infinity);
    expect(sync.status().lastError).toBeNull();
    expect(sync.status().import.done).toBe(true);
    expect(store.stats().total).toBe(230);
  });

  it('picks up new plays after the import', async () => {
    const source = new TestSource(new MockHistorySource(Date.now() - 60_000, 80));
    const { store, sync } = setup(source);
    await sync.syncOnce(Infinity);
    expect(store.stats().total).toBe(80);

    const [template] = (await new MockHistorySource(Date.now(), 1).listHistoryPage({})).items;
    source.extra.push({ ...template!, session_id: 'brand-new', ended_at: new Date().toISOString() });
    source.calls.length = 0;
    await sync.syncOnce(Infinity);

    expect(store.stats().total).toBe(81);
    // Only recent plays were requested, not the whole history again.
    expect(source.calls.every((q) => q.endedAfter)).toBe(true);
  });

  it('restarts the import if Silo rejects the saved cursor', async () => {
    const source = new TestSource(new MockHistorySource(Date.now(), 230));
    const { store, sync } = setup(source);
    store.setState('import_cursor', 'stale-cursor');
    source.failNext = new SiloError('Invalid cursor', 400);
    await sync.syncOnce(Infinity);
    expect(sync.status().import.done).toBe(true);
    expect(store.stats().total).toBe(230);
  });
});
