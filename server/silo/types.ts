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
