import { describe, expect, it } from 'vitest';
import { playMethodOf, summarize, toActivityStream } from '../server/activity/map.js';
import { MockSessionSource } from '../server/silo/mock.js';
import type { SiloSession } from '../server/silo/types.js';

async function mockSessions(): Promise<SiloSession[]> {
  return new MockSessionSource().listSessions();
}

describe('toActivityStream', () => {
  it('maps an episode with its series details', async () => {
    const session = (await mockSessions()).find((s) => s.media_type === 'episode')!;
    const stream = toActivityStream(session);
    expect(stream.id).toBe(session.session_id);
    expect(stream.media.seriesTitle).toBe(session.series_title);
    expect(stream.media.seasonNumber).toBe(session.season_number);
    expect(stream.user.name).toBe(session.username);
  });

  it('turns empty strings from Silo into nulls', async () => {
    const [session] = await mockSessions();
    const stream = toActivityStream({ ...session!, series_title: '', client_ip: '', poster_url: '' });
    expect(stream.media.seriesTitle).toBeNull();
    expect(stream.client.ip).toBeNull();
    expect(stream.media.posterUrl).toBeNull();
  });

  it('copes with a session missing optional fields', () => {
    const minimal = {
      session_id: 's1',
      user_id: '1',
      username: 'someone',
      profile_id: 'p1',
      media_file_id: 'f1',
      media_title: 'Something',
      media_type: 'movie',
      play_method: 'direct',
      reporting_node: 'silo',
      file_duration: null,
      started_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:05Z',
      position_seconds: 5,
      is_paused: false,
      stream_location: 'remote',
      stream_bitrate_kbps: null,
      source_bitrate_kbps: null,
      source_audio_channels: null,
      subtitle: null,
    } satisfies SiloSession;
    const stream = toActivityStream(minimal);
    expect(stream.media.durationSeconds).toBeNull();
    expect(stream.playback.reasons).toEqual([]);
    expect(stream.subtitle).toBeNull();
  });
});

describe('playMethodOf', () => {
  it('prefers the effective play method', async () => {
    const [session] = await mockSessions();
    expect(playMethodOf({ ...session!, play_method: 'direct', effective_play_method: 'remux' })).toBe('remux');
  });

  it('falls back to direct for unknown values', async () => {
    const [session] = await mockSessions();
    expect(playMethodOf({ ...session!, play_method: 'teleport', effective_play_method: '' })).toBe('direct');
  });
});

describe('summarize', () => {
  it('counts streams by state, method and location', async () => {
    const streams = (await mockSessions()).map(toActivityStream);
    const summary = summarize(streams);
    expect(summary.total).toBe(streams.length);
    expect(summary.playing + summary.paused).toBe(summary.total);
    expect(summary.local + summary.remote).toBe(summary.total);
    expect(Object.values(summary.byMethod).reduce((a, b) => a + b, 0)).toBe(summary.total);
    expect(summary.bandwidthKbps).toBeGreaterThan(0);
  });

  it('handles no streams', () => {
    expect(summarize([])).toMatchObject({ total: 0, playing: 0, bandwidthKbps: 0 });
  });
});
