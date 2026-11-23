import type { ActivityStream, PlayMethod } from '../../../shared/activity';

/** 3725 → "1:02:05", 125 → "2:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/** 4537 → "4.5 Mbps", 820 → "820 kbps", 696882 → "696.9 Mbps". */
export function formatBitrate(kbps: number | null | undefined): string {
  if (kbps == null) return '—';
  if (kbps >= 1_000_000) return `${(kbps / 1_000_000).toFixed(2)} Gbps`;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export const PLAY_METHOD_LABELS: Record<PlayMethod, string> = {
  direct: 'Direct Play',
  direct_stream: 'Direct Stream',
  remux: 'Remux',
  transcode: 'Transcode',
};

const REASON_LABELS: Record<string, string> = {
  video_codec_unsupported: 'Video codec not supported',
  video_capability_unconfirmed: 'Video support unconfirmed',
  dynamic_range_unsupported: 'HDR not supported',
  resolution_limit: 'Resolution limit',
  bandwidth_limit: 'Bandwidth limit',
  bandwidth_cap: 'Bandwidth cap',
  server_bitrate_limit: 'Server bitrate limit',
  buffering: 'Buffering',
  quality_selected: 'Quality chosen by user',
  subtitle_burn_in: 'Subtitle burn-in',
  subtitle_unsupported: 'Subtitle not supported',
  direct_play_failed: 'Direct play failed',
  audio_codec_unsupported: 'Audio codec not supported',
  audio_channels_unsupported: 'Audio channels not supported',
  audio_track_selection: 'Audio track selection',
  container_unsupported: 'Container not supported',
  device_workaround: 'Device workaround',
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? sentenceCase(reason.replace(/_/g, ' '));
}

const PLATFORM_LABELS: Record<string, string> = {
  'android-tv': 'Android TV',
  android: 'Android',
  ios: 'iOS',
  ipados: 'iPadOS',
  tvos: 'tvOS',
  macos: 'macOS',
  web: 'Web',
  roku: 'Roku',
  windows: 'Windows',
  linux: 'Linux',
};

export function platformLabel(platform: string | null): string | null {
  if (!platform) return null;
  return PLATFORM_LABELS[platform.toLowerCase()] ?? sentenceCase(platform.replace(/[-_]/g, ' '));
}

export function channelsLabel(channels: number | null, layout?: string | null): string | null {
  const named = layout?.match(/\d\.\d/)?.[0];
  if (named) return named;
  if (channels == null) return layout ?? null;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} ch`;
}

export function codecLabel(codec: string | null): string | null {
  if (!codec) return null;
  const known: Record<string, string> = { hevc: 'HEVC', h264: 'H.264', h265: 'HEVC', av1: 'AV1', vp9: 'VP9', eac3: 'EAC3', ac3: 'AC3', truehd: 'TrueHD', dts: 'DTS', aac: 'AAC', opus: 'Opus', flac: 'FLAC', mp3: 'MP3', srt: 'SRT', subrip: 'SRT', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', mov_text: 'TX3G', webvtt: 'WebVTT', pgs: 'PGS', ass: 'ASS', vtt: 'WebVTT' };
  return known[codec.toLowerCase()] ?? codec.toUpperCase();
}

export function episodeCode(season: number | null, episode: number | null): string | null {
  if (season == null && episode == null) return null;
  const s = season != null ? `S${String(season).padStart(2, '0')}` : '';
  const e = episode != null ? `E${String(episode).padStart(2, '0')}` : '';
  return s + e;
}

/** The main heading and subheading for a stream card. */
export function titleLines(stream: ActivityStream): { title: string; subtitle: string | null } {
  const { media } = stream;
  if (media.type === 'episode' && media.seriesTitle) {
    const code = episodeCode(media.seasonNumber, media.episodeNumber);
    return { title: media.seriesTitle, subtitle: [code, media.title].filter(Boolean).join(' · ') };
  }
  return { title: media.title, subtitle: null };
}

/**
 * Estimate the current playback position between updates, so progress bars
 * move smoothly. Silo reports positions every few seconds; we extrapolate from
 * when this browser received the snapshot, and never by more than a minute.
 */
export function livePosition(
  stream: ActivityStream,
  fetchedAt: string | null,
  receivedAt: number,
  now: number,
): number {
  const { positionSeconds, paused, updatedAt } = stream.progress;
  const duration = stream.media.durationSeconds;
  if (paused) return positionSeconds;

  const staleAtFetch = fetchedAt ? (Date.parse(fetchedAt) - Date.parse(updatedAt)) / 1000 : 0;
  const sinceReceived = (now - receivedAt) / 1000;
  const elapsed = Math.min(60, Math.max(0, (Number.isFinite(staleAtFetch) ? staleAtFetch : 0) + sinceReceived));
  const estimate = positionSeconds + elapsed;
  return duration ? Math.min(duration, estimate) : estimate;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 6070 → "1h 41m", 754 → "12m", 45 → "45s". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return '—';
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/** "Today 14:32", "Yesterday 09:10", "Mon 17 Nov 14:32", or with the year if it isn't this year. */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString(undefined, {
    weekday: days < 7 ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
  return `${day} ${time}`;
}

export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

const END_REASON_LABELS: Record<string, string> = {
  stopped: 'Stopped by the viewer',
  terminated: 'Stopped by an admin',
  expired: 'Player stopped responding',
  aborted: 'Failed to start',
  replaced: 'Replaced by a new stream',
};

export function endReasonLabel(reason: string | null): string {
  if (!reason) return 'Unknown';
  return END_REASON_LABELS[reason] ?? sentenceCase(reason.replace(/_/g, ' '));
}
