import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { LibraryService, episodeRange } from '../server/library/library.js';
import { CatalogSync } from '../server/library/sync.js';
import { type CatalogSource, SiloError } from '../server/silo/client.js';
import { MockCatalogSource, MockHistorySource } from '../server/silo/mock.js';
import type { SiloCatalogItem } from '../server/silo/types.js';

const quiet = () => {};

async function setup(source: CatalogSource = new MockCatalogSource()) {
  const db = openDatabase(':memory:');
  const sync = new CatalogSync(db, source, { intervalMs: 60_000, log: quiet });
  await sync.syncOnce();
  return { db, sync, library: new LibraryService(db, sync) };
}

describe('CatalogSync and LibraryService', () => {
  it('copies libraries, movies and shows', async () => {
    const { library, sync } = await setup();
    const result = library.libraries();
    expect(sync.error).toBeNull();
    expect(result.status.ready).toBe(true);
    expect(result.status.libraryNamesAvailable).toBe(true);
    expect(result.libraries.map((l) => l.name)).toEqual(['Movies', 'TV Shows', '4K Movies']);
    expect(result.totals.movies).toBeGreaterThan(0);
    expect(result.totals.shows).toBeGreaterThan(0);
    const tv = result.libraries.find((l) => l.name === 'TV Shows')!;
    expect(tv.shows).toBe(result.totals.shows);
    expect(tv.movies).toBe(0);
  });

  it('groups new episodes of a show into one card', async () => {
    const { library } = await setup();
    const items = library.recent({ kind: 'show' });
    const grouped = items.filter((i) => i.episodeCount);
    expect(grouped.length).toBeGreaterThan(0);
    for (const g of grouped) {
      expect(g.episodeRange).toMatch(/^S\d/);
    }
    expect(items.every((i) => i.kind !== 'movie')).toBe(true);
    // Never two cards for the same show.
    const titles = items.map((i) => i.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('filters recently added by library and newest first', async () => {
    const { library } = await setup();
    const fourK = library.recent({ libraryId: '3', days: 60 });
    expect(fourK.every((i) => i.libraryIds.includes('3'))).toBe(true);
    const all = library.recent({ days: 60 });
    const dates = all.map((i) => i.addedAt);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('falls back to numbered libraries without libraries:read', async () => {
    const mock = new MockCatalogSource();
    const source: CatalogSource = {
      listUsers: () => mock.listUsers(),
      listCatalogPage: (q) => mock.listCatalogPage(q),
      listLibraries: () => Promise.reject(new SiloError('API key scopes do not permit this route', 403)),
    };
    const { library, sync } = await setup(source);
    expect(sync.error).toBeNull();
    const result = library.libraries();
    expect(result.status.libraryNamesAvailable).toBe(false);
    expect(result.libraries.map((l) => l.name)).toContain('Library 1');
  });

  it('removes movies Silo no longer has on the next full sync', async () => {
    const mock = new MockCatalogSource();
    let removed: string | null = null;
    const source: CatalogSource = {
      listUsers: () => mock.listUsers(),
      listLibraries: () => mock.listLibraries(),
      listCatalogPage: async (q) => {
        const page = await mock.listCatalogPage(q);
        return removed ? { ...page, items: page.items.filter((i: SiloCatalogItem) => i.content_id !== removed) } : page;
      },
    };
    const { db, sync } = await setup(source);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM catalog_items WHERE type = 'movie'").get() as { n: number }).n;
    removed = 'mock-movie-1';
    await sync.syncFull();
    const after = (db.prepare("SELECT COUNT(*) AS n FROM catalog_items WHERE type = 'movie'").get() as { n: number }).n;
    expect(after).toBe(before - 1);
  });

  it('counts plays per library from the history', async () => {
    const { db, library } = await setup();
    const history = new HistoryStore(db);
    const plays = (await new MockHistorySource().listHistoryPage({ limit: 300 })).items;
    // Point demo plays of a movie at a catalog movie.
    history.upsert(plays.slice(0, 5).map((p, i) => ({ ...p, session_id: `p${i}`, media_type: 'movie', media_item_id: 'mock-movie-2', started_at: new Date().toISOString() })));
    const result = library.libraries();
    const total = result.libraries.reduce((sum, l) => sum + l.playsLast30Days, 0);
    expect(total).toBe(5);
  });
});

describe('episodeRange', () => {
  it('describes sets of episodes', () => {
    expect(episodeRange([{ season_number: 2, episode_number: 4 }])).toBe('S2 E4');
    expect(episodeRange([{ season_number: 2, episode_number: 7 }, { season_number: 2, episode_number: 4 }])).toBe('S2 E4–E7');
    expect(episodeRange([{ season_number: 1, episode_number: 9 }, { season_number: 2, episode_number: 2 }])).toBe('S1 E9 – S2 E2');
    expect(episodeRange([{ season_number: null, episode_number: null }])).toBe('1 episode');
  });
});
