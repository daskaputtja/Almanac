/**
 * Almanac's own view of a live stream.
 *
 * The dashboard only ever sees these types, never Silo's raw API rows, so a
 * change in Silo's API only needs fixing in `server/activity/map.ts`.
 */

export type PlayMethod = 'direct' | 'direct_stream' | 'remux' | 'transcode';
export type Decision = 'direct' | 'remux' | 'transcode' | 'copy' | string;
export type StreamLocation = 'local' | 'remote';
export type MediaType = 'movie' | 'episode' | string;

export interface ActivityStream {
  id: string;
  user: {
    id: string;
    name: string;
    profileName: string | null;
  };
  media: {
    type: MediaType;
    title: string;
    seriesTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    itemId: string | null;
    posterUrl: string | null;
    durationSeconds: number | null;
  };
  progress: {
    positionSeconds: number;
    paused: boolean;
    startedAt: string;
    /** When Silo last heard from the client; used to interpolate progress. */
    updatedAt: string;
  };
  client: {
    name: string | null;
    version: string | null;
    label: string | null;
    platform: string | null;
    deviceId: string | null;
    ip: string | null;
    location: StreamLocation;
  };
  playback: {
    method: PlayMethod;
    videoDecision: Decision | null;
    audioDecision: Decision | null;
    /** Why Silo is not direct playing, e.g. `video_codec_unsupported`. */
    reasons: string[];
    hardwareAcceleration: string | null;
    toneMapping: string | null;
  };
  video: {
    sourceCodec: string | null;
    sourceResolution: string | null;
    targetCodec: string | null;
    targetResolution: string | null;
  };
  audio: {
    sourceCodec: string | null;
    sourceChannels: number | null;
    sourceLayout: string | null;
    language: string | null;
    targetCodec: string | null;
    targetChannels: number | null;
  };
  subtitle: {
    language: string | null;
    codec: string | null;
    delivery: string | null;
    forced: boolean;
  } | null;
  container: {
    source: string | null;
    output: string | null;
    protocol: string | null;
  };
  bandwidth: {
    streamKbps: number | null;
    sourceKbps: number | null;
  };
  node: string | null;
}

export interface ActivitySummary {
  total: number;
  playing: number;
  paused: number;
  byMethod: Record<PlayMethod, number>;
  local: number;
  remote: number;
  bandwidthKbps: number;
}

export interface ActivitySnapshot {
  streams: ActivityStream[];
  summary: ActivitySummary;
  /** When Almanac last received a successful answer from Silo. */
  fetchedAt: string | null;
  /** The last error talking to Silo, or null if the last poll succeeded. */
  error: string | null;
}
