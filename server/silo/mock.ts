import type { CatalogSource, HistorySource, ServerSource, SessionSource } from './client.js';
import type {
  CatalogPageQuery,
  HistoryPageQuery,
  SiloCatalogItem,
  SiloCollection,
  SiloHistoryEntry,
  SiloLibrary,
  SiloNodeSummary,
  SiloServerStatus,
  SiloSession,
  SiloSystemInfo,
  SiloUser,
} from './types.js';

/**
 * A fake Silo server for development and screenshots, enabled with
 * `SILO_MOCK=true`. All users, titles and addresses are made up.
 */

interface Template {
  title: string;
  type: 'movie' | 'episode';
  series?: string;
  season?: number;
  episode?: number;
  duration: number;
  user: string;
  client: string;
  platform: string;
  method: 'direct' | 'direct_stream' | 'remux' | 'transcode';
  reasons?: string[];
  resolution: string;
  targetResolution?: string;
  codec: string;
  audio: string;
  channels: number;
  bitrate: number;
  location: 'local' | 'remote';
}

const TEMPLATES: Template[] = [
  { title: 'The Long Harvest', type: 'movie', duration: 7260, user: 'marigold', client: 'Silo Web', platform: 'web', method: 'transcode', reasons: ['video_codec_unsupported'], resolution: '2160p', targetResolution: '1080p', codec: 'hevc', audio: 'truehd', channels: 8, bitrate: 48_000, location: 'remote' },
  { title: 'Signals', type: 'episode', series: 'Northern Lights Station', season: 2, episode: 5, duration: 3120, user: 'pike', client: 'Silo Android TV', platform: 'android-tv', method: 'direct', resolution: '1080p', codec: 'h264', audio: 'eac3', channels: 6, bitrate: 6_200, location: 'local' },
  { title: 'Iron Orchard', type: 'movie', duration: 6480, user: 'wren', client: 'Silo iOS', platform: 'ios', method: 'transcode', reasons: ['bandwidth_limit'], resolution: '1080p', targetResolution: '720p', codec: 'h264', audio: 'aac', channels: 2, bitrate: 9_800, location: 'remote' },
  { title: 'The Quiet Market', type: 'episode', series: 'Cobblestone', season: 1, episode: 3, duration: 2700, user: 'juniper', client: 'Silo tvOS', platform: 'tvos', method: 'remux', reasons: ['container_unsupported'], resolution: '2160p', codec: 'hevc', audio: 'eac3', channels: 6, bitrate: 22_000, location: 'local' },
  { title: 'Paper Comets', type: 'movie', duration: 5940, user: 'atlas', client: 'Infuse', platform: 'ios', method: 'direct_stream', reasons: ['audio_codec_unsupported'], resolution: '1080p', codec: 'h264', audio: 'dts', channels: 6, bitrate: 11_500, location: 'remote' },
  { title: 'Ledger', type: 'episode', series: 'Counting House', season: 3, episode: 10, duration: 3480, user: 'marigold', client: 'Silo Android', platform: 'android', method: 'direct', resolution: '720p', codec: 'h264', audio: 'aac', channels: 2, bitrate: 3_100, location: 'remote' },
  { title: 'Low Tide', type: 'episode', series: 'Harbour Lights', season: 1, episode: 1, duration: 2940, user: 'sable', client: 'Findroid', platform: 'android', method: 'transcode', reasons: ['subtitle_burn_in'], resolution: '1080p', targetResolution: '1080p', codec: 'h264', audio: 'ac3', channels: 6, bitrate: 8_400, location: 'local' },
];

function fakeIp(i: number, location: 'local' | 'remote'): string {
  return location === 'local' ? `192.168.1.${20 + i}` : `203.0.113.${40 + i}`;
}

export class MockSessionSource implements SessionSource {
  private readonly startedAt = Date.now();

  async listSessions(): Promise<SiloSession[]> {
    const now = Date.now();
    const elapsed = (now - this.startedAt) / 1000;

    return TEMPLATES.map((t, i): SiloSession => {
      // Each stream starts part-way through and loops, with one paused stream.
      const paused = i === 3;
      const offset = t.duration * ((i * 0.13 + 0.1) % 0.9);
      const position = paused ? offset : (offset + elapsed) % t.duration;
      const transcoding = t.method === 'transcode';

      return {
        session_id: `mock-session-${i + 1}`,
        user_id: String(100 + i),
        username: t.user,
        profile_id: `mock-profile-${i + 1}`,
        profile_name: 'Main',
        media_file_id: String(5000 + i),
        media_item_id: `mock-item-${i + 1}`,
        media_title: t.title,
        media_type: t.type,
        series_title: t.series,
        season_number: t.season,
        episode_number: t.episode,
        play_method: t.method,
        effective_play_method: t.method,
        video_decision: transcoding ? 'transcode' : t.method === 'remux' ? 'remux' : 'direct',
        audio_decision: t.method === 'direct' ? 'direct' : 'transcode',
        adaptation_reasons: t.reasons,
        reporting_node: 'silo',
        node_display_name: 'Local server',
        file_duration: t.duration,
        started_at: new Date(this.startedAt - offset * 1000).toISOString(),
        updated_at: new Date(now).toISOString(),
        position_seconds: position,
        is_paused: paused,
        client_ip: fakeIp(i, t.location),
        stream_location: t.location,
        client_name: t.client,
        client_version: '1.0.0',
        client_label: `${t.client} 1.0.0`,
        device_id: `mock-device-${i + 1}`,
        device_platform: t.platform,
        stream_bitrate_kbps: transcoding ? Math.round(t.bitrate * 0.4) : t.bitrate,
        source_bitrate_kbps: t.bitrate,
        source_container: 'mkv',
        output_container: t.method === 'direct' ? 'mkv' : 'fmp4',
        output_protocol: t.method === 'direct' ? 'http' : 'hls',
        source_video_codec: t.codec,
        source_video_resolution: t.resolution,
        target_video_codec: transcoding ? 'h264' : undefined,
        target_resolution: t.targetResolution,
        source_audio_codec: t.audio,
        source_audio_channels: t.channels,
        source_audio_language: 'en',
        source_audio_layout: t.channels > 2 ? '5.1' : 'stereo',
        target_audio_codec: t.method === 'direct' ? undefined : 'aac',
        target_audio_channels: t.method === 'direct' ? undefined : 2,
        transcode_hw_accel: transcoding ? 'vaapi' : undefined,
        subtitle: t.reasons?.includes('subtitle_burn_in')
          ? { language: 'en', codec: 'pgs', delivery: 'burn_in', forced: false }
          : null,
      };
    });
  }
}

/** A small seeded random number generator, so demo history is the same every run. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Thirty days of made-up finished plays, built from the same demo titles and users. */
export class MockHistorySource implements HistorySource {
  private readonly entries: SiloHistoryEntry[];

  constructor(now = Date.now(), count = 600) {
    const random = seededRandom(42);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const users = [...new Set(TEMPLATES.map((t) => t.user))];
    const endReasons = ['stopped', 'stopped', 'stopped', 'stopped', 'expired', 'aborted', 'terminated'];

    this.entries = Array.from({ length: count }, (_, i): SiloHistoryEntry => {
      const t = pick(TEMPLATES);
      const user = pick(users);
      const endedAt = now - random() * 30 * 86_400_000;
      const startPosition = random() < 0.7 ? 0 : Math.floor(random() * t.duration * 0.6);
      const watched = Math.max(5, Math.floor(random() * (t.duration - startPosition)));
      const completed = random() < 0.55;
      const played = completed ? t.duration - startPosition : watched;
      const paused = Math.floor(random() * 300);
      const startedAt = endedAt - (played + paused) * 1000;
      const location = random() < 0.4 ? 'local' : 'remote';

      return {
        session_id: `mock-play-${i + 1}`,
        user_id: String(100 + users.indexOf(user)),
        username: user,
        profile_id: `mock-profile-${user}`,
        profile_name: 'Main',
        media_item_id: `mock-item-${TEMPLATES.indexOf(t) + 1}`,
        media_file_id: String(5000 + TEMPLATES.indexOf(t)),
        media_title: t.title,
        media_type: t.type,
        play_method: t.method,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        end_position_seconds: startPosition + played,
        duration_seconds: t.duration,
        completed,
        played_seconds: played,
        series_title: t.series ?? '',
        season_number: t.season ?? null,
        episode_number: t.episode ?? null,
        measured: true,
        start_position_seconds: startPosition,
        paused_seconds: paused,
        client_ip: fakeIp(i % 20, location),
        device_id: `mock-device-${user}`,
        device_platform: t.platform,
        client_name: t.client,
        client_version: '1.0.0',
        video_decision: t.method === 'transcode' ? 'transcode' : t.method === 'remux' ? 'remux' : 'direct',
        audio_decision: t.method === 'direct' ? 'direct' : 'transcode',
        end_reason: completed ? 'stopped' : pick(endReasons),
        subtitle: null,
        lifecycle_seq: i + 1,
      };
    }).sort((a, b) => b.ended_at.localeCompare(a.ended_at) || b.session_id.localeCompare(a.session_id));
  }

  async listHistoryPage(query: HistoryPageQuery): Promise<SiloCollection<SiloHistoryEntry>> {
    const limit = query.limit ?? 200;
    const offset = query.cursor ? Number(query.cursor) : 0;
    const matching = query.endedAfter
      ? this.entries.filter((e) => e.ended_at >= query.endedAfter!)
      : this.entries;
    const items = matching.slice(offset, offset + limit);
    const hasMore = offset + limit < matching.length;
    return { items, page: { has_more: hasMore, next_cursor: hasMore ? String(offset + limit) : undefined } };
  }
}

const MOCK_LIBRARIES = [
  { id: '1', name: 'Movies', type: 'movies', sort_order: 1 },
  { id: '2', name: 'TV Shows', type: 'shows', sort_order: 2 },
  { id: '3', name: '4K Movies', type: 'movies', sort_order: 3 },
];

const EXTRA_MOVIES = [
  'Glass Lanterns', 'The Salt Road', 'Kettle Hill', 'Northbound', 'A Field of Clocks', 'Driftwood Kings',
  'The Cartographer', 'Seven Bridges', 'Halfway House', 'Copper Sky', 'The Night Ferry', 'Thimble',
];
const EXTRA_SERIES = ['Weather Station', 'The Orchard Years', 'Lighthouse Keepers', 'Market Day'];

/** Made-up accounts, libraries and catalog for demo mode. */
export class MockCatalogSource implements CatalogSource {
  private readonly items: SiloCatalogItem[];

  constructor(private readonly now = Date.now()) {
    const random = seededRandom(7);
    const daysAgo = (max: number) => new Date(now - random() * max * 86_400_000).toISOString();
    const quality = () => {
      const fourK = random() < 0.3;
      return [{ resolution: fourK ? '2160p' : random() < 0.8 ? '1080p' : '720p', codec_video: fourK ? 'hevc' : 'h264', dynamic_range: fourK && random() < 0.6 ? 'HDR10' : 'SDR', file_size: Math.round((fourK ? 40 : 8) * 1e9 * (0.5 + random())) }];
    };

    const movieTitles = [...new Set([...TEMPLATES.filter((t) => t.type === 'movie').map((t) => t.title), ...EXTRA_MOVIES])];
    const movies = movieTitles.map((title, i): SiloCatalogItem => {
      const versions = quality();
      return {
        content_id: `mock-movie-${i + 1}`,
        type: 'movie',
        title,
        year: 1990 + Math.floor(random() * 36),
        library_ids: versions[0]!.resolution === '2160p' ? ['3'] : ['1'],
        added_at: daysAgo(i < 6 ? 10 : 400),
        genres: [['Drama'], ['Comedy'], ['Thriller'], ['Adventure', 'Family']][i % 4],
        rating_imdb: Math.round((5 + random() * 4) * 10) / 10,
        versions,
      };
    });

    const seriesTitles = [...new Set([...TEMPLATES.filter((t) => t.series).map((t) => t.series!), ...EXTRA_SERIES])];
    const series: SiloCatalogItem[] = [];
    const episodes: SiloCatalogItem[] = [];
    seriesTitles.forEach((title, i) => {
      const id = `mock-series-${i + 1}`;
      series.push({ content_id: id, type: 'series', title, year: 2010 + i, library_ids: ['2'], added_at: daysAgo(500), genres: ['Drama'], rating_imdb: 7 + (i % 3) / 2, versions: [] });
      const newEpisodes = i % 2 === 0 ? 1 + Math.floor(random() * 5) : 0;
      for (let e = 0; e < newEpisodes; e++) {
        episodes.push({ content_id: `${id}-s2e${e + 1}`, type: 'episode', title: `Episode ${e + 1}`, series_id: id, series_title: title, season_number: 2, episode_number: e + 1, library_ids: ['2'], added_at: daysAgo(14), versions: quality() });
      }
    });

    this.items = [...movies, ...series, ...episodes];
  }

  async listUsers(): Promise<SiloUser[]> {
    const names = [...new Set(TEMPLATES.map((t) => t.user)), 'quill'];
    return names.map((username, i) => ({
      id: String(100 + i),
      username,
      role: i === 0 ? 'admin' : 'user',
      enabled: username !== 'quill',
      is_owner: i === 0,
      created_at: new Date(this.now - (400 - i * 30) * 86_400_000).toISOString(),
      last_active_at: new Date(this.now - i * 3_600_000).toISOString(),
    }));
  }

  async listLibraries(): Promise<SiloLibrary[]> {
    return MOCK_LIBRARIES;
  }

  async listCatalogPage(query: CatalogPageQuery): Promise<SiloCollection<SiloCatalogItem>> {
    const limit = query.limit ?? 200;
    const offset = query.cursor ? Number(query.cursor) : 0;
    const matching = this.items.filter((i) => i.type === query.type && (!query.addedAfter || i.added_at >= query.addedAfter));
    const items = matching.slice(offset, offset + limit);
    const hasMore = offset + limit < matching.length;
    return { items, page: { has_more: hasMore, next_cursor: hasMore ? String(offset + limit) : undefined } };
  }
}

/** A healthy made-up server for demo mode. */
export class MockServerSource implements ServerSource {
  private readonly startedAt = new Date(Date.now() - 18 * 3_600_000 - 16 * 60_000).toISOString();

  async serverStatus(): Promise<SiloServerStatus> {
    return {
      started_at: this.startedAt,
      restart_required: false,
      health: { postgres: { configured: true, ok: true, latency_ms: 0.03 }, redis: { configured: true, ok: true, latency_ms: 0.11 } },
    };
  }

  async nodes(): Promise<SiloNodeSummary[]> {
    return Array.from({ length: 4 }, (_, i) => ({ id: String(i + 1), name: `node-${i + 1}`, enabled: true, healthy: true }));
  }

  async systemInfo(): Promise<SiloSystemInfo> {
    return { server_version: 'demo1234' };
  }
}
