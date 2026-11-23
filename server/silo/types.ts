/**
 * The parts of Silo's `/api/v2` responses that Almanac reads.
 *
 * Written from Silo's OpenAPI schema (`AdminPlaybackSession`). Fields are
 * optional unless Silo marks them as required, and Silo is still pre-release,
 * so code reading these must tolerate missing values.
 */

export interface SiloPage {
  next_cursor?: string;
  has_more?: boolean;
}

export interface SiloCollection<T> {
  items: T[];
  page?: SiloPage;
}

export interface SiloSubtitle {
  track_id?: string;
  language?: string;
  codec?: string;
  format?: string;
  source?: string;
  delivery?: string;
  forced?: boolean;
  hearing_impaired?: boolean;
}

export interface SiloSession {
  session_id: string;
  user_id: string;
  username: string;
  profile_id: string;
  profile_name?: string;
  media_file_id: string;
  media_item_id?: string;
  media_title: string;
  media_type: string;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
  poster_url?: string;
  play_method: string;
  effective_play_method?: string;
  video_decision?: string;
  audio_decision?: string;
  adaptation_reasons?: string[];
  reporting_node: string;
  node_display_name?: string;
  file_duration: number | null;
  started_at: string;
  updated_at: string;
  position_seconds: number;
  is_paused: boolean;
  client_ip?: string;
  stream_location: 'local' | 'remote';
  client_name?: string;
  client_version?: string;
  client_label?: string;
  device_id?: string;
  device_platform?: string;
  stream_bitrate_kbps: number | null;
  source_bitrate_kbps: number | null;
  output_container?: string;
  output_protocol?: string;
  source_container?: string;
  source_video_codec?: string;
  source_video_resolution?: string;
  target_video_codec?: string;
  target_resolution?: string;
  source_audio_codec?: string;
  source_audio_channels: number | null;
  source_audio_language?: string;
  source_audio_layout?: string;
  target_audio_codec?: string;
  target_audio_channels?: number;
  transcode_hw_accel?: string;
  tone_map_mode?: string;
  subtitle: SiloSubtitle | null;
}

/** RFC 9457 problem response, which Silo returns for errors. */
export interface SiloProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
}

/** One finished playback attempt from `GET /api/v2/admin/playback-history`. */
export interface SiloHistoryEntry {
  session_id: string;
  user_id: string;
  /** Empty when the account no longer exists. */
  username: string;
  profile_id: string;
  profile_name: string;
  /** Empty when the attempt was not attributed to an item. */
  media_item_id: string;
  media_file_id: string;
  /** Empty when the item is no longer in the catalog. */
  media_title: string;
  media_type: string;
  play_method: string;
  started_at: string;
  ended_at: string;
  end_position_seconds: number;
  duration_seconds: number | null;
  completed: boolean;
  played_seconds: number | null;
  series_title: string;
  season_number: number | null;
  episode_number: number | null;
  measured: boolean;
  start_position_seconds: number | null;
  paused_seconds: number | null;
  client_ip: string | null;
  device_id: string | null;
  device_platform: string | null;
  client_name: string | null;
  client_version: string | null;
  video_decision: string | null;
  audio_decision: string | null;
  end_reason: string | null;
  subtitle: SiloSubtitle | null;
  lifecycle_seq: number | null;
}

export interface HistoryPageQuery {
  cursor?: string;
  /** Inclusive lower bound on `ended_at`. Must be repeated with every cursor. */
  endedAfter?: string;
  limit?: number;
}
