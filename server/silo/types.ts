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
  routing_egress_node_name?: string;
  routing_execution_node_name?: string;
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

/** An account from `GET /api/v2/admin/users`. Only the fields Almanac keeps. */
export interface SiloUser {
  id: string;
  username: string;
  role?: string;
  enabled?: boolean;
  is_owner?: boolean;
  created_at?: string;
  last_active_at?: string | null;
}

/** A library from `GET /api/v2/user/libraries` (needs the `libraries:read` scope). */
export interface SiloLibrary {
  id: string;
  name: string;
  type?: string;
  sort_order?: number;
}

export interface SiloCatalogVersion {
  file_id?: string;
  library_id?: string;
  resolution?: string;
  codec_video?: string;
  codec_audio?: string;
  dynamic_range?: string;
  audio_channels?: number;
  bitrate_kbps?: number;
  file_size?: number;
  container?: string;
  atmos?: boolean;
  /** For example "IMAX", "Extended" or "Directors Cut". */
  edition?: string;
}

/** A movie, series or episode from `GET /api/v2/admin/catalog/items`. */
export interface SiloCatalogItem {
  content_id: string;
  type: 'movie' | 'series' | 'episode' | string;
  title: string;
  year?: number;
  series_id?: string;
  series_title?: string;
  season_number?: number;
  episode_number?: number;
  library_ids?: string[];
  added_at: string;
  poster_url?: string;
  genres?: string[];
  rating_imdb?: number;
  rating_tmdb?: number;
  versions?: SiloCatalogVersion[];
  /** "matched" once Silo has found the title's metadata. */
  status?: string;
  imdb_id?: string;
  tmdb_id?: string;
  tvdb_id?: string;
  content_rating?: string;
  release_date?: string;
  air_date?: string;
}

export interface CatalogPageQuery {
  type?: 'movie' | 'series' | 'episode';
  addedAfter?: string;
  /** Only items in this library; added_at is then when the item first appeared in it. */
  libraryId?: string;
  /** Only these items. */
  contentIds?: string[];
  cursor?: string;
  limit?: number;
}

/** From `GET /api/v2/admin/server/status`. */
export interface SiloServerStatus {
  started_at?: string;
  restart_required?: boolean;
  health?: {
    postgres?: { configured?: boolean; ok?: boolean; latency_ms?: number };
    redis?: { configured?: boolean; ok?: boolean; latency_ms?: number };
  };
}

/** One node from `GET /api/v2/admin/nodes/summary` (only the fields Almanac reads). */
export interface SiloNodeSummary {
  id: string;
  name?: string;
  enabled?: boolean;
  healthy?: boolean;
}

/** From `GET /api/v2/system/info`. */
export interface SiloSystemInfo {
  server_version?: string;
}

/** From `GET /api/v2/admin/stats/timeseries`: one sample of server load. */
export interface SiloLoadPoint {
  t: string;
  streams: number;
  direct?: number;
  remux?: number;
  transcode?: number;
  egress_kbps?: number;
}

export interface SiloTimeseries {
  resolution_seconds: number;
  points: SiloLoadPoint[];
}

/** One node from `GET /api/v2/admin/nodes/summary`, with the details the Nodes page shows. */
export interface SiloNodeDetail {
  id: string;
  name?: string;
  type?: string;
  group?: string;
  enabled?: boolean;
  healthy?: boolean;
  active_jobs?: number;
  max_jobs?: number | null;
  egress_kbps?: number;
  max_bandwidth_kbps?: number | null;
  drain_state?: string;
  last_health_check?: string;
  resources?: {
    system?: { cpu_pct?: number; cores?: number; load1?: number; mem_used_mb?: number; mem_total_mb?: number };
  };
}
