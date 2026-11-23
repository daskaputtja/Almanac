import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import type { SiloHistoryEntry } from '../server/silo/types.js';
import { TrendingService } from '../server/trending/trending.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');
let n = 0;
function play(user: string, daysAgo: number, show: string, extra: Partial<SiloHistoryEntry> = {}): SiloHistoryEntry {
  const start = NOW - daysAgo * 86_400_000;
  n++;
  return {
    session_id: `t${n}`, user_id: user, username: user, profile_id: 'p', profile_name: 'Main',
    media_item_id: `${show}-ep${n}`, media_file_id: `f${n}`, media_title: `Episode ${n}`, media_type: 'episode', play_method: 'direct',
    started_at: new Date(start).toISOString(), ended_at: new Date(start + 1_800_000).toISOString(),
    end_position_seconds: 1800, duration_seconds: 1800, completed: true, played_seconds: 1800,
    series_title: show, season_number: 1, episode_number: n, measured: true, start_position_seconds: 0, paused_seconds: 0,
    client_ip: null, device_id: null, device_platform: null, client_name: null, client_version: null,
    video_decision: 'direct', audio_decision: 'direct', end_reason: 'stopped', subtitle: null, lifecycle_seq: n, ...extra,
  };
}

describe('TrendingService', () => {
  it('finds rising, popular and binged titles', () => {
    const db = openDatabase(':memory:');
    const plays = [
      // Steady: 6 viewers both weeks.
      ...['a', 'b', 'c', 'd', 'e', 'f'].flatMap((u) => [play(u, 2, 'Steady'), play(u, 9, 'Steady')]),
      // Rising: 1 viewer last week, 5 this week.
      play('a', 10, 'Rising'),
      ...['a', 'b', 'c', 'd', 'e'].map((u) => play(u, 3, 'Rising')),
      // One person watching a lot isn't "rising".
      ...Array.from({ length: 10 }, () => play('z', 1, 'Solo')),
      // Binging: two viewers, four episodes each, in the last 48 hours.
      ...['x', 'y'].flatMap((u) => [0, 1, 2, 3].map(() => play(u, 0.5, 'Binge'))),
      // A movie, new this week.
      ...['a', 'b', 'c'].map((u) => play(u, 1, '', { media_type: 'movie', media_item_id: 'movie-1', media_title: 'New Movie', series_title: '' })),
    ];
    new HistoryStore(db).upsert(plays);
    const t = new TrendingService(db).get(NOW);

    expect(t.popular[0]).toMatchObject({ title: 'Steady', viewers: 6, changePercent: 0 });
    expect(t.rising.map((i) => i.title)).toEqual(expect.arrayContaining(['Rising', 'New Movie']));
    expect(t.rising.map((i) => i.title)).not.toContain('Solo');
    expect(t.rising.map((i) => i.title)).not.toContain('Steady');
    expect(t.rising.find((i) => i.title === 'Rising')).toMatchObject({ viewers: 5, previousViewers: 1, changePercent: 400 });
    expect(t.rising.find((i) => i.title === 'New Movie')).toMatchObject({ kind: 'movie', changePercent: null });
    expect(t.binging[0]).toMatchObject({ title: 'Binge', viewers: 2, episodesPerViewer: 4 });
  });
});
