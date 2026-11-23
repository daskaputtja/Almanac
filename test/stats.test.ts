import { describe, expect, it } from 'vitest';
import { parseStatsQuery } from '../server/app.js';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { MockHistorySource } from '../server/silo/mock.js';
import { StatsService, platformKey } from '../server/stats/stats.js';
import type { SiloHistoryEntry } from '../server/silo/types.js';
import { buildTimeline, buildWeekHourGrid, niceTicks } from '../web/src/lib/statsData.js';

async function setup(extra: SiloHistoryEntry[] = []) {
  const db = openDatabase(':memory:');
  const store = new HistoryStore(db);
  const entries = (await new MockHistorySource(Date.parse('2026-06-15T12:00:00Z'), 300).listHistoryPage({ limit: 300 })).items;
  store.upsert([...entries, ...extra]);
  return { stats: new StatsService(db), entries };
}

describe('StatsService', () => {
  it('totals match the stored plays', async () => {
    const { stats, entries } = await setup();
    const result = stats.get({});
    expect(result.totals.plays).toBe(entries.length);
    expect(Object.values(result.totals.byMethod).reduce((a, b) => a + b, 0)).toBe(entries.length);
    expect(result.hours.reduce((sum, h) => sum + h[1], 0)).toBe(entries.length);
    expect(result.totals.users).toBe(new Set(entries.map((e) => e.user_id)).size);
  });

  it('filters by user and period', async () => {
    const { stats, entries } = await setup();
    const userId = entries[0]!.user_id;
    expect(stats.get({ userId }).totals.plays).toBe(entries.filter((e) => e.user_id === userId).length);
    const from = '2026-06-08T00:00:00.000Z';
    expect(stats.get({ from }).totals.plays).toBe(entries.filter((e) => e.started_at >= from).length);
  });

  it('ranks top lists by plays or watch time', async () => {
    const { stats } = await setup();
    const byPlays = stats.get({ rankBy: 'plays' }).top.users.map((u) => u.plays);
    expect(byPlays).toEqual([...byPlays].sort((a, b) => b - a));
    const byWatched = stats.get({ rankBy: 'watched' }).top.movies.map((m) => m.watchedSeconds);
    expect(byWatched).toEqual([...byWatched].sort((a, b) => b - a));
  });

  it('merges platform spellings and encoded player names', async () => {
    const { entries } = await setup();
    const base = entries.find((e) => e.device_platform === 'android')!;
    const { stats } = await setup([
      { ...base, session_id: 'x1', device_platform: 'Android', client_name: 'Jellyfin+for+Android' },
      { ...base, session_id: 'x2', device_platform: 'Android', client_name: 'Jellyfin for Android' },
    ]);
    const platforms = stats.get({ limit: 50 }).top.platforms;
    expect(platforms.filter((p) => platformKey(p.name) === 'android')).toHaveLength(1);
    const jellyfin = stats.get({ limit: 50 }).top.players.filter((p) => p.name === 'Jellyfin for Android');
    expect(jellyfin).toHaveLength(1);
    expect(jellyfin[0]!.plays).toBe(2);
  });

  it('parses query parameters', () => {
    expect(parseStatsQuery({ rankBy: 'watched', limit: '500', minWatched: '30', user: '7' })).toEqual({
      from: undefined,
      to: undefined,
      userId: '7',
      minWatchedSeconds: 30,
      rankBy: 'watched',
      limit: 50,
    });
    expect(parseStatsQuery({ rankBy: 'nonsense' }).rankBy).toBe('plays');
  });
});

describe('stats helpers', () => {
  it('makes round axis ticks', () => {
    expect(niceTicks(2300)).toEqual([0, 1000, 2000, 3000]);
    expect(niceTicks(47)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });

  it('buckets UTC hours into local days, including empty days', () => {
    const from = new Date(2026, 0, 1, 12);
    const to = new Date(2026, 0, 3, 12);
    const hour = (d: Date) => d.toISOString().slice(0, 13);
    const timeline = buildTimeline(
      [[hour(new Date(2026, 0, 1, 20)), 3, 600, 2, 0, 0, 1]],
      from,
      to,
      'day',
    );
    expect(timeline).toHaveLength(3);
    expect(timeline[0]!.plays).toBe(3);
    expect(timeline[0]!.byMethod.transcode).toBe(1);
    expect(timeline[1]!.plays).toBe(0);
  });

  it('builds a Monday-first weekday by hour grid in local time', () => {
    const monday9pm = new Date(2026, 0, 5, 21); // 5 Jan 2026 is a Monday
    const grid = buildWeekHourGrid([[monday9pm.toISOString().slice(0, 13), 4, 0, 4, 0, 0, 0]]);
    expect(grid[0]![21]).toBe(4);
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(4);
  });
});
