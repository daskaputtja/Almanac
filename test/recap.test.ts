import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { CatalogSync } from '../server/library/sync.js';
import { RecapError, RecapService } from '../server/recap/recap.js';
import { MockCatalogSource } from '../server/silo/mock.js';
import type { SiloHistoryEntry } from '../server/silo/types.js';

const HOUR = 3_600_000;

function entry(i: number, user: string, start: string, hours: number, extra: Partial<SiloHistoryEntry> = {}): SiloHistoryEntry {
  const startMs = Date.parse(start);
  return {
    session_id: `r${i}`,
    user_id: user,
    username: `user${user}`,
    profile_id: 'p',
    profile_name: 'Main',
    media_item_id: `ep${i}`,
    media_file_id: `f${i}`,
    media_title: `Episode ${i}`,
    media_type: 'episode',
    play_method: 'direct',
    started_at: new Date(startMs).toISOString(),
    ended_at: new Date(startMs + hours * HOUR).toISOString(),
    end_position_seconds: hours * 3600,
    duration_seconds: hours * 3600,
    completed: true,
    played_seconds: hours * 3600,
    series_title: 'Harbour Lights',
    season_number: 1,
    episode_number: i,
    measured: true,
    start_position_seconds: 0,
    paused_seconds: 0,
    client_ip: '203.0.113.1',
    device_id: 'd',
    device_platform: 'android-tv',
    client_name: 'Jellyfin+for+Android+TV',
    client_version: '1',
    video_decision: 'direct',
    audio_decision: 'direct',
    end_reason: 'stopped',
    subtitle: null,
    lifecycle_seq: i,
    ...extra,
  };
}

async function setup() {
  const db = openDatabase(':memory:');
  await new CatalogSync(db, new MockCatalogSource(), { intervalMs: 60_000, log: () => {} }).syncOnce();
  const plays: SiloHistoryEntry[] = [
    // User 1: a 4-episode binge on 10 March (back to back), a movie, and a play the next year.
    ...[0, 1, 2, 3].map((i) => entry(i, '1', `2026-03-10T18:${String(i * 15).padStart(2, '0')}:00Z`, 0.24)),
    entry(10, '1', '2026-03-11T20:00:00Z', 2, { media_type: 'movie', media_item_id: 'mock-movie-1', media_title: 'The Long Harvest', series_title: '' }),
    entry(11, '1', '2027-01-02T20:00:00Z', 1),
    // User 2: watches less.
    entry(20, '2', '2026-05-01T20:00:00Z', 0.5),
    // User 3: watches more.
    ...[0, 1, 2].map((i) => entry(30 + i, '3', `2026-0${i + 6}-01T20:00:00Z`, 3, { series_title: 'Counting House' })),
  ];
  new HistoryStore(db).upsert(plays);
  return new RecapService(db);
}

describe('RecapService', () => {
  it('sums one user’s year', async () => {
    const recap = (await setup()).get(2026, '1');
    expect(recap.scope).toBe('user');
    expect(recap.user).toEqual({ id: '1', name: 'user1' });
    expect(recap.totals).toMatchObject({ plays: 5, movies: 1, episodes: 4, shows: 1, titles: 2 });
    expect(recap.totals.watchedSeconds).toBe(Math.round((4 * 0.24 + 2) * 3600));
    expect(recap.availableYears).toEqual([2027, 2026]);
  });

  it('finds top titles, binges, sittings and favourites', async () => {
    const recap = (await setup()).get(2026, '1');
    expect(recap.topShows[0]).toMatchObject({ title: 'Harbour Lights', detail: '4 episodes' });
    expect(recap.topMovies[0]).toMatchObject({ title: 'The Long Harvest', year: expect.any(Number) });
    expect(recap.topGenres[0]?.genre).toBe('Drama'); // the demo catalog's genre for that movie
    expect(recap.biggestBinge).toMatchObject({ title: 'Harbour Lights', episodes: 4, date: '2026-03-10' });
    expect(recap.biggestBinge).not.toHaveProperty('userName');
    // The 2-hour movie is a longer sitting than the 59-minute binge.
    expect(recap.longestSitting).toMatchObject({ seconds: 7200, titles: 1 });
    expect(recap.favouritePlayer?.name).toBe('Jellyfin for Android TV');
    expect(recap.firstPlay?.title).toBe('Harbour Lights: Episode 0');
    expect(recap.lastPlay?.title).toBe('The Long Harvest');
    expect(recap.directPlayPercent).toBe(100);
  });

  it('compares a user with everyone else that year', async () => {
    const service = await setup();
    expect(service.get(2026, '1').percentile).toBe(50); // more than user 2, less than user 3
    expect(service.get(2026, '3').percentile).toBe(100);
    expect(service.get(2026, '2').percentile).toBe(0);
  });

  it('sums the whole server', async () => {
    const recap = (await setup()).get(2026, null);
    expect(recap.scope).toBe('server');
    expect(recap.totals.plays).toBe(9);
    expect(recap.server!.activeUsers).toBe(3);
    expect(recap.server!.topUsers.map((u) => u.id)).toEqual(['3', '1', '2']);
    expect(recap.biggestBinge?.userName).toBe('user1');
    expect(recap.longestSitting).toBeNull();
    expect(recap.percentile).toBeNull();
    expect(recap.server!.newMovies + recap.server!.newShows).toBeGreaterThanOrEqual(0);
  });

  it('says when history starts part-way through the year', async () => {
    const recap = (await setup()).get(2026, null);
    expect(recap.coverage.partial).toBe(true);
    expect(recap.coverage.from).toBe('2026-03-10T18:00:00.000Z');
  });

  it('handles empty years and unknown users', async () => {
    const service = await setup();
    expect(service.get(2025, '1').totals.plays).toBe(0);
    expect(() => service.get(2026, 'nobody')).toThrow(RecapError);
  });
});
