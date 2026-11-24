import type { AccountSource, CatalogSource, HistorySource, ServerSource, SessionSource } from './client.js';
import type {
  CatalogPageQuery,
  HistoryPageQuery,
  SiloCatalogItem,
  SiloCollection,
  SiloDevice,
  SiloDownload,
  SiloHistoryEntry,
  SiloLibrary,
  SiloNodeDetail,
  SiloNodeSummary,
  SiloPlaybackActivity,
  SiloServerStatus,
  SiloSession,
  SiloSystemInfo,
  SiloTimeseries,
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
        routing_egress_node_name: `node-${(i % 3) + 1}`,
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
      email: `${username}@example.com`,
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
    const matching = this.items.filter(
      (i) =>
        (!query.type || i.type === query.type) &&
        (!query.addedAfter || i.added_at >= query.addedAfter) &&
        (!query.libraryId || (i.library_ids ?? []).includes(query.libraryId)) &&
        (!query.contentIds || query.contentIds.includes(i.content_id)),
    );
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

  /** A daily rhythm: quiet before dawn, busiest in the evening. */
  async timeseries(hours: number): Promise<SiloTimeseries> {
    const resolution = hours <= 24 ? 300 : hours <= 168 ? 1800 : 7200;
    const now = Math.floor(Date.now() / (resolution * 1000)) * resolution * 1000;
    const count = Math.floor((hours * 3600) / resolution);
    const points = Array.from({ length: count }, (_, i) => {
      const t = now - (count - 1 - i) * resolution * 1000;
      const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
      const curve = 0.5 + 0.5 * Math.sin(((hour - 14) / 24) * 2 * Math.PI);
      const streams = Math.round(4 + 40 * curve + ((t / 60000) % 7));
      const transcode = Math.round(streams * 0.12);
      return { t: new Date(t).toISOString(), streams, direct: streams - transcode - 1, remux: 1, transcode, egress_kbps: streams * 9000 };
    });
    return { resolution_seconds: resolution, points };
  }

  async playbackActivity(hours: number): Promise<SiloPlaybackActivity> {
    const started = Math.round(hours * 42);
    const completed = Math.round(started * 0.56);
    return {
      hours,
      reliability: {
        sessions_started: started,
        transcode_starts: Math.round(started * 0.08),
        finalized_sessions: started - 3,
        completed_sessions: completed,
        completion_rate: completed / (started - 3),
        unique_profiles: Math.min(420, Math.round(40 + hours * 4)),
      },
      profiles_active_24h: 120,
    };
  }

  async nodeDetails(): Promise<SiloNodeDetail[]> {
    return Array.from({ length: 4 }, (_, i) => ({
      id: String(i + 1),
      name: `node-${i + 1}`,
      type: i < 3 ? 'proxy' : 'transcode',
      group: 'main',
      enabled: true,
      healthy: true,
      active_jobs: [5, 2, 0, 3][i],
      max_jobs: null,
      egress_kbps: [42_000, 18_500, 0, 9_000][i],
      drain_state: 'none',
      last_health_check: new Date().toISOString(),
      resources: { system: { cpu_pct: [12, 7, 2, 48][i], cores: 8, load1: [1.2, 0.6, 0.1, 3.9][i], mem_used_mb: [9_000, 6_200, 3_100, 14_000][i], mem_total_mb: 32_000 } },
    }));
  }
}

/** Made-up offline downloads and registered devices for demo mode. */
export class MockAccountSource implements AccountSource {
  constructor(private readonly now = Date.now()) {}

  async listDownloads(): Promise<SiloDownload[]> {
    const random = seededRandom(11);
    const titles = ['Glass Lanterns', 'The Salt Road', 'Kettle Hill', 'Northbound', 'Copper Sky', 'The Night Ferry', 'Thimble', 'Seven Bridges'];
    const downloads: SiloDownload[] = [];
    // One busy downloader, a couple of occasional ones.
    const plan: [string, string, number][] = [
      ['101', 'pike', 46],
      ['102', 'wren', 6],
      ['104', 'atlas', 2],
    ];
    let n = 0;
    for (const [userId, username, count] of plan) {
      for (let i = 0; i < count; i++) {
        const isEpisode = i % 3 !== 0;
        const created = new Date(this.now - (userId === '101' ? random() * 5 : random() * 25) * 86_400_000).toISOString();
        downloads.push({
          id: `dl-${++n}`,
          user_id: userId,
          username,
          profile_id: `${userId}-main`,
          device_id: `${userId}-phone`,
          device_name: userId === '101' ? 'Pixel 9' : 'iPad',
          content_id: isEpisode ? 'mock-series-1' : `mock-movie-${(i % 8) + 1}`,
          title: isEpisode ? 'Weather Station' : titles[i % titles.length],
          media_type: isEpisode ? 'series' : 'movie',
          episode: isEpisode ? { season_number: 1 + Math.floor(i / 10), episode_number: (i % 10) + 1, title: `Episode ${(i % 10) + 1}` } : null,
          status: random() < 0.85 ? 'completed' : 'ready',
          quality: 'original',
          file_size: Math.round((isEpisode ? 1.2 : 6) * 1e9 * (0.5 + random())),
          created_at: created,
          completed_at: created,
          created_client_ip: `203.0.113.${10 + Number(userId) - 100}`,
        });
      }
    }
    return downloads;
  }

  async listDevices(): Promise<SiloDevice[]> {
    const devices: SiloDevice[] = [];
    const names: [string, string][] = [
      ['Living Room TV', 'android-tv'],
      ['iPhone', 'iOS'],
      ['Chrome on Windows', 'Windows Web'],
      ['Apple TV', 'tvOS'],
    ];
    for (let u = 0; u < 6; u++) {
      // Account 103 is used on far more devices than anyone else.
      const count = u === 3 ? 17 : 2 + (u % 3);
      for (let d = 0; d < count; d++) {
        const [name, platform] = names[d % names.length]!;
        devices.push({
          user_id: String(100 + u),
          device_id: `${100 + u}-device-${d}`,
          device_name: d < names.length ? name : `${name} ${Math.floor(d / names.length) + 1}`,
          device_platform: platform,
          profile_count: 1 + (d % 2),
          profiles: [{ profile_id: `${100 + u}-main`, profile_name: 'Main' }],
          last_updated: new Date(this.now - d * 1.5 * 86_400_000).toISOString(),
        });
      }
    }
    return devices;
  }
}
