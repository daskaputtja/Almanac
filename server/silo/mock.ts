import type { SessionSource } from './client.js';
import type { SiloSession } from './types.js';

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
