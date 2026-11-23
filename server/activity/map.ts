import type {
  ActivityStream,
  ActivitySummary,
  PlayMethod,
} from '../../shared/activity.js';
import type { SiloSession } from '../silo/types.js';

const PLAY_METHODS: PlayMethod[] = ['direct', 'direct_stream', 'remux', 'transcode'];

/** Silo sends empty strings for many unset fields; treat those as missing. */
function str(value: string | undefined | null): string | null {
  return value ? value : null;
}

function num(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Some clients (notably Jellyfin apps) report URL-encoded names such as
 * `Jellyfin+for+Android+TV`; turn those into normal text.
 */
export function cleanClientName(name: string | null | undefined): string | null {
  if (!name) return null;
  let clean = name;
  if (!clean.includes(' ') && clean.includes('+')) clean = clean.replace(/\+/g, ' ');
  if (/%[0-9A-Fa-f]{2}/.test(clean)) {
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // Leave it as it was.
    }
  }
  return clean.trim() || null;
}

/** Silo's play method as one of the four Almanac knows, defaulting to direct. */
export function normalizePlayMethod(method: string | null | undefined): PlayMethod {
  return method && (PLAY_METHODS as string[]).includes(method) ? (method as PlayMethod) : 'direct';
}

export function playMethodOf(session: SiloSession): PlayMethod {
  return normalizePlayMethod(session.effective_play_method || session.play_method);
}

export function toActivityStream(s: SiloSession): ActivityStream {
  return {
    id: s.session_id,
    user: {
      id: s.user_id,
      name: s.username,
      profileName: str(s.profile_name),
    },
    media: {
      type: s.media_type,
      title: s.media_title,
      seriesTitle: str(s.series_title),
      seasonNumber: num(s.season_number),
      episodeNumber: num(s.episode_number),
      itemId: str(s.media_item_id),
      posterUrl: str(s.poster_url),
      durationSeconds: num(s.file_duration),
    },
    progress: {
      positionSeconds: num(s.position_seconds) ?? 0,
      paused: s.is_paused,
      startedAt: s.started_at,
      updatedAt: s.updated_at,
    },
    client: {
      name: cleanClientName(s.client_name),
      version: str(s.client_version),
      label: str(s.client_label),
      platform: str(s.device_platform),
      deviceId: str(s.device_id),
      ip: str(s.client_ip),
      location: s.stream_location === 'local' ? 'local' : 'remote',
    },
    playback: {
      method: playMethodOf(s),
      videoDecision: str(s.video_decision),
      audioDecision: str(s.audio_decision),
      reasons: s.adaptation_reasons ?? [],
      hardwareAcceleration: str(s.transcode_hw_accel),
      toneMapping: str(s.tone_map_mode),
    },
    video: {
      sourceCodec: str(s.source_video_codec),
      sourceResolution: str(s.source_video_resolution),
      targetCodec: str(s.target_video_codec),
      targetResolution: str(s.target_resolution),
    },
    audio: {
      sourceCodec: str(s.source_audio_codec),
      sourceChannels: num(s.source_audio_channels),
      sourceLayout: str(s.source_audio_layout),
      language: str(s.source_audio_language),
      targetCodec: str(s.target_audio_codec),
      targetChannels: num(s.target_audio_channels),
    },
    subtitle: s.subtitle
      ? {
          language: str(s.subtitle.language),
          codec: str(s.subtitle.codec),
          delivery: str(s.subtitle.delivery),
          forced: s.subtitle.forced ?? false,
        }
      : null,
    container: {
      source: str(s.source_container),
      output: str(s.output_container),
      protocol: str(s.output_protocol),
    },
    bandwidth: {
      streamKbps: num(s.stream_bitrate_kbps),
      sourceKbps: num(s.source_bitrate_kbps),
    },
    node: str(s.node_display_name) ?? str(s.reporting_node),
  };
}

export function summarize(streams: ActivityStream[]): ActivitySummary {
  const byMethod: Record<PlayMethod, number> = { direct: 0, direct_stream: 0, remux: 0, transcode: 0 };
  let paused = 0;
  let local = 0;
  let bandwidthKbps = 0;

  for (const stream of streams) {
    byMethod[stream.playback.method]++;
    if (stream.progress.paused) paused++;
    if (stream.client.location === 'local') local++;
    bandwidthKbps += stream.bandwidth.streamKbps ?? 0;
  }

  return {
    total: streams.length,
    playing: streams.length - paused,
    paused,
    byMethod,
    local,
    remote: streams.length - local,
    bandwidthKbps,
  };
}
