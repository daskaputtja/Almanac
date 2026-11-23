import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { CatalogSync } from '../server/library/sync.js';
import { ServerOverviewService } from '../server/server/overview.js';
import type { ServerSource } from '../server/silo/client.js';
import { MockCatalogSource, MockHistorySource, MockServerSource } from '../server/silo/mock.js';

describe('ServerOverviewService', () => {
  it('combines Silo health with Almanac’s counts', async () => {
    const db = openDatabase(':memory:');
    await new CatalogSync(db, new MockCatalogSource(), { intervalMs: 60_000, log: () => {} }).syncOnce();
    const plays = (await new MockHistorySource().listHistoryPage({ limit: 300 })).items;
    const recent = plays.map((p, i) => ({ ...p, started_at: new Date(Date.now() - (i % 48) * 3_600_000).toISOString() }));
    new HistoryStore(db).upsert(recent);

    const overview = new ServerOverviewService(db, new MockServerSource());
    await overview.refresh();
    const o = overview.overview();

    expect(o.version).toBe('demo1234');
    expect(o.postgres).toEqual({ ok: true, latencyMs: 0.03 });
    expect(o.nodes).toEqual({ healthy: 4, total: 4 });
    expect(Date.now() - Date.parse(o.startedAt!)).toBeGreaterThan(18 * 3_600_000);
    expect(o.movies.count).toBeGreaterThan(0);
    expect(o.movies.libraries).toBe(2); // Movies and 4K Movies
    expect(o.shows.libraries).toBe(1);
    const expectedProfiles = new Set(
      recent.filter((p) => Date.parse(p.started_at) >= Date.now() - 86_400_000).map((p) => `${p.user_id}:${p.profile_id}`),
    ).size;
    expect(o.profiles24h).toBe(expectedProfiles);
    expect(o.problems).toEqual([]);
  });

  it('keeps the last good answer when Silo fails, and says what failed', async () => {
    const db = openDatabase(':memory:');
    const mock = new MockServerSource();
    let failing = false;
    const source: ServerSource = {
      serverStatus: () => (failing ? Promise.reject(new Error('timeout')) : mock.serverStatus()),
      nodes: () => mock.nodes(),
      systemInfo: () => mock.systemInfo(),
    };
    const overview = new ServerOverviewService(db, source);
    await overview.refresh();
    failing = true;
    await overview.refresh();
    const o = overview.overview();
    expect(o.postgres?.ok).toBe(true);
    expect(o.problems).toEqual(['Server status: timeout']);
  });
});
