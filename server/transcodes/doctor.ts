import type { ActivityStream } from '../../shared/activity.js';
import type { TranscodeReport, TranscodeSuggestion } from '../../shared/transcodes.js';
import { cleanClientName } from '../activity/map.js';
import { type Database, transaction } from '../db/database.js';
import { platformKey } from '../stats/stats.js';

/** Don't rewrite a stream's row more often than this. */
const RECORD_EVERY_MS = 30_000;
const KEEP_DAYS = 180;
const COUNTED = '(watched_seconds IS NULL OR watched_seconds >= 30)';
/** Percentages from a handful of streams mislead; wait for this many converted streams. */
const MIN_CONVERTED_FOR_SUGGESTIONS = 30;

/** Plain-English names for Silo's reasons, used in suggestions. */
export const REASON_TEXT: Record<string, string> = {
  video_codec_unsupported: 'the player can’t decode the video',
  video_capability_unconfirmed: 'the player didn’t confirm it supports the video',
  dynamic_range_unsupported: 'the player can’t show HDR',
  resolution_limit: 'a resolution limit',
  bandwidth_limit: 'the viewer’s bandwidth limit',
  bandwidth_cap: 'a bandwidth cap',
  server_bitrate_limit: 'the server’s bitrate limit',
  buffering: 'buffering',
  quality_selected: 'the viewer choosing a lower quality',
  subtitle_burn_in: 'subtitles being burned in',
  subtitle_unsupported: 'unsupported subtitles',
  direct_play_failed: 'direct play failing',
  audio_codec_unsupported: 'the player can’t decode the audio',
  audio_channels_unsupported: 'the player can’t handle the audio channels',
  audio_track_selection: 'the chosen audio track',
  container_unsupported: 'the file container',
  device_workaround: 'a device workaround',
};

/**
 * Records details of live streams (Silo's history doesn't keep why a play
 * was transcoded) and turns them, with play history, into a report on what
 * causes transcodes and what to do about it.
 */
export class TranscodeDoctor {
  private readonly lastWritten = new Map<string, number>();

  constructor(private readonly db: Database) {}

  /** Called with each activity snapshot. */
  record(streams: ActivityStream[], now = Date.now()): void {
    const due = streams.filter((s) => now - (this.lastWritten.get(s.id) ?? 0) >= RECORD_EVERY_MS);
    if (!due.length) return;
    const nowIso = new Date(now).toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO stream_observations (session_id, user_id, first_seen, last_seen, method, video_decision, audio_decision, reasons,
         media_type, title, series_title, item_id, file_id, source_video, source_resolution, target_resolution, source_audio,
         source_channels, subtitle_codec, subtitle_delivery, player, platform, hw_accel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET last_seen = excluded.last_seen, method = excluded.method,
         video_decision = excluded.video_decision, audio_decision = excluded.audio_decision,
         -- Keep every reason seen during the stream, not just the latest.
         reasons = (SELECT json_group_array(DISTINCT value) FROM (
           SELECT value FROM json_each(stream_observations.reasons) UNION SELECT value FROM json_each(excluded.reasons))),
         target_resolution = COALESCE(excluded.target_resolution, stream_observations.target_resolution),
         subtitle_codec = excluded.subtitle_codec, subtitle_delivery = excluded.subtitle_delivery, hw_accel = excluded.hw_accel`,
    );
    transaction(this.db, () => {
      for (const s of due) {
        upsert.run(
          s.id,
          s.user.id,
          nowIso,
          nowIso,
          s.playback.method,
          s.playback.videoDecision,
          s.playback.audioDecision,
          JSON.stringify(s.playback.reasons),
          s.media.type,
          s.media.title,
          s.media.seriesTitle,
          s.media.itemId,
          s.media.fileId,
          s.video.sourceCodec,
          s.video.sourceResolution,
          s.video.targetResolution,
          s.audio.sourceCodec,
          s.audio.sourceChannels,
          s.subtitle?.codec ?? null,
          s.subtitle?.delivery ?? null,
          s.client.name,
          s.client.platform,
          s.playback.hardwareAcceleration,
        );
        this.lastWritten.set(s.id, now);
      }
    });
    // Forget sessions that have ended, and old observations.
    const live = new Set(streams.map((s) => s.id));
    for (const id of this.lastWritten.keys()) if (!live.has(id)) this.lastWritten.delete(id);
    if (Math.random() < 0.01) {
      this.db.prepare('DELETE FROM stream_observations WHERE last_seen < ?').run(new Date(now - KEEP_DAYS * 86_400_000).toISOString());
    }
  }

  report(days: number, now = Date.now()): TranscodeReport {
    const since = new Date(now - days * 86_400_000).toISOString();

    // --- From play history ---
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(play_method = 'direct') AS direct, SUM(play_method = 'direct_stream') AS ds,
                SUM(play_method = 'remux') AS remux, SUM(play_method = 'transcode') AS transcode
         FROM plays WHERE started_at >= ? AND ${COUNTED}`,
      )
      .get(since) as { total: number; direct: number | null; ds: number | null; remux: number | null; transcode: number | null };

    const rawPlayers = this.db
      .prepare(
        `SELECT client_name AS name, device_platform AS platform, COUNT(*) AS plays, SUM(play_method = 'transcode') AS transcodes
         FROM plays WHERE started_at >= ? AND ${COUNTED} AND client_name IS NOT NULL AND client_name <> ''
         GROUP BY client_name, device_platform`,
      )
      .all(since) as { name: string; platform: string | null; plays: number; transcodes: number }[];
    const merged = new Map<string, { name: string; platform: string | null; plays: number; transcodes: number }>();
    for (const p of rawPlayers) {
      const name = cleanClientName(p.name) ?? p.name;
      const key = `${name}|${p.platform ? platformKey(p.platform) : ''}`;
      const m = merged.get(key);
      if (m) {
        m.plays += p.plays;
        m.transcodes += p.transcodes;
      } else merged.set(key, { name, platform: p.platform, plays: p.plays, transcodes: p.transcodes });
    }
    const players = [...merged.values()]
      .filter((p) => p.transcodes > 0)
      .map((p) => ({ ...p, rate: Math.round((p.transcodes / p.plays) * 1000) / 10 }))
      .sort((a, b) => b.transcodes - a.transcodes)
      .slice(0, 15);

    // --- From live streams Almanac watched ---
    const obsWhere = 'WHERE last_seen >= ?';
    const observed = (this.db.prepare(`SELECT COUNT(*) AS n FROM stream_observations ${obsWhere}`).get(since) as { n: number }).n;
    const observedSince = (this.db.prepare('SELECT MIN(first_seen) AS m FROM stream_observations').get() as { m: string | null }).m;
    const converted = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM stream_observations ${obsWhere} AND method <> 'direct'`).get(since) as { n: number }
    ).n;

    const reasons = (
      this.db
        .prepare(
          `SELECT j.value AS reason, COUNT(*) AS streams FROM stream_observations o, json_each(o.reasons) j
           ${obsWhere} AND o.method <> 'direct' GROUP BY j.value ORDER BY streams DESC`,
        )
        .all(since) as { reason: string; streams: number }[]
    ).map((r) => ({ ...r, share: converted ? Math.round((r.streams / converted) * 1000) / 10 : 0 }));

    const sources = (
      this.db
        .prepare(
          `SELECT TRIM(COALESCE(source_resolution, '') || ' ' || COALESCE(UPPER(source_video), '')) AS video,
                  COUNT(*) AS streams, SUM(method = 'transcode') AS transcodes
           FROM stream_observations ${obsWhere} GROUP BY video HAVING transcodes > 0 ORDER BY transcodes DESC LIMIT 10`,
        )
        .all(since) as { video: string; streams: number; transcodes: number }[]
    ).map((s) => ({ ...s, video: s.video || 'Unknown', rate: Math.round((s.transcodes / s.streams) * 1000) / 10 }));

    const files = (
      this.db
        .prepare(
          `SELECT file_id AS fileId,
                  MAX(CASE WHEN media_type = 'episode' AND series_title IS NOT NULL THEN series_title || ': ' || title ELSE title END) AS title,
                  COUNT(*) AS transcodes, COUNT(DISTINCT user_id) AS users,
                  MAX(TRIM(COALESCE(source_resolution, '') || ' ' || COALESCE(UPPER(source_video), '') || ' · ' || COALESCE(UPPER(source_audio), ''))) AS source,
                  (SELECT json_group_array(DISTINCT j.value) FROM stream_observations o2, json_each(o2.reasons) j
                   WHERE o2.file_id = o.file_id AND o2.method = 'transcode') AS reasons
           FROM stream_observations o ${obsWhere} AND method = 'transcode' AND file_id IS NOT NULL
           GROUP BY file_id ORDER BY transcodes DESC, users DESC LIMIT 20`,
        )
        .all(since) as { fileId: string; title: string; transcodes: number; users: number; source: string; reasons: string }[]
    ).map((f) => ({ ...f, reasons: parseList(f.reasons) }));

    const report: TranscodeReport = {
      days,
      plays: {
        total: totals.total,
        direct: totals.direct ?? 0,
        directStream: totals.ds ?? 0,
        remux: totals.remux ?? 0,
        transcode: totals.transcode ?? 0,
      },
      players,
      observedSince,
      observed,
      convertedObserved: converted,
      minimumForSuggestions: MIN_CONVERTED_FOR_SUGGESTIONS,
      reasons,
      sources,
      files,
      suggestions: [],
    };
    report.suggestions = this.suggest(report, since);
    return report;
  }

  /** Turn the numbers into a short to-do list, biggest wins first. */
  private suggest(r: TranscodeReport, since: string): TranscodeSuggestion[] {
    const out: (TranscodeSuggestion & { weight: number })[] = [];
    const impact = (share: number): TranscodeSuggestion['impact'] => (share >= 25 ? 'high' : share >= 10 ? 'medium' : 'low');
    const totalTranscodes = Math.max(1, r.plays.transcode);

    // Players that transcode a lot, with their usual reason.
    for (const p of r.players.slice(0, 5)) {
      if (p.plays < 20 || p.rate < 30) continue;
      const top = this.db
        .prepare(
          `SELECT j.value AS reason, COUNT(*) AS n FROM stream_observations o, json_each(o.reasons) j
           WHERE o.last_seen >= ? AND o.player = ? AND o.method <> 'direct' GROUP BY j.value ORDER BY n DESC LIMIT 1`,
        )
        .get(since, p.name) as { reason: string; n: number } | undefined;
      const share = (p.transcodes / totalTranscodes) * 100;
      out.push({
        weight: share,
        impact: impact(share),
        title: `${p.name} transcodes ${Math.round(p.rate)}% of its plays`,
        detail: `${p.transcodes.toLocaleString('en')} transcodes in ${r.days} days (${Math.round(share)}% of all of them)${
          top ? `, mostly because ${REASON_TEXT[top.reason] ?? top.reason.replace(/_/g, ' ')}` : ''
        }. Pointing these viewers to a player that plays your files directly, such as the Silo app, would avoid most of them.`,
      });
    }

    // Everything below is based on reasons and files from watched streams:
    // only worth saying once there are enough of them.
    if (r.convertedObserved < MIN_CONVERTED_FOR_SUGGESTIONS) {
      return out.sort((a, b) => b.weight - a.weight).map(({ weight: _w, ...s }) => s);
    }
    const reason = (key: string) => r.reasons.find((x) => x.reason === key);

    const subs = reason('subtitle_burn_in');
    if (subs && subs.share >= 5) {
      const codecs = this.db
        .prepare(
          `SELECT UPPER(subtitle_codec) AS codec, COUNT(*) AS n FROM stream_observations o, json_each(o.reasons) j
           WHERE o.last_seen >= ? AND j.value = 'subtitle_burn_in' AND subtitle_codec IS NOT NULL GROUP BY codec ORDER BY n DESC LIMIT 2`,
        )
        .all(since) as { codec: string; n: number }[];
      out.push({
        weight: subs.share,
        impact: impact(subs.share),
        title: 'Subtitles are forcing transcodes',
        detail: `${Math.round(subs.share)}% of converted streams burned in subtitles${
          codecs.length ? ` (mostly ${codecs.map((c) => c.codec).join(' and ')})` : ''
        }. Image and styled subtitles can’t be sent as text, so the video is re-encoded. Adding SRT versions of those subtitles avoids it.`,
      });
    }

    const audio = reason('audio_codec_unsupported');
    if (audio && audio.share >= 10) {
      out.push({
        weight: audio.share,
        impact: impact(audio.share),
        title: 'Audio formats players can’t decode',
        detail: `${Math.round(audio.share)}% of converted streams were for the audio, usually TrueHD, DTS or FLAC on web and TV apps. Files with an extra AC3 or AAC track play directly on far more devices.`,
      });
    }

    const hdr = reason('dynamic_range_unsupported');
    const videoCodec = reason('video_codec_unsupported');
    const fourK = r.sources.find((s) => /2160p/.test(s.video));
    if ((videoCodec && videoCodec.share >= 10) || (hdr && hdr.share >= 10)) {
      const share = (videoCodec?.share ?? 0) + (hdr?.share ?? 0);
      out.push({
        weight: share,
        impact: impact(share),
        title: 'Video players can’t play (HEVC, 4K or HDR)',
        detail: `${Math.round(share)}% of converted streams were because the player couldn’t handle the video${
          fourK ? `; ${fourK.video} alone was transcoded ${fourK.transcodes.toLocaleString('en')} times` : ''
        }. Keeping 1080p H.264 versions alongside 4K and HEVC files (for example in a separate library) lets older devices play directly.`,
      });
    }

    const bandwidth = (reason('bandwidth_limit')?.share ?? 0) + (reason('bandwidth_cap')?.share ?? 0) + (reason('server_bitrate_limit')?.share ?? 0);
    if (bandwidth >= 15) {
      out.push({
        weight: bandwidth,
        impact: impact(bandwidth),
        title: 'Bandwidth limits cause many transcodes',
        detail: `${Math.round(bandwidth)}% of converted streams were to fit a bandwidth limit or cap. If those limits are set in Silo’s user policies, raising them for people with fast connections would avoid these.`,
      });
    }

    const chosen = reason('quality_selected');
    if (chosen && chosen.share >= 10) {
      out.push({
        weight: 0,
        impact: 'low',
        title: 'Some transcodes are viewers’ own choice',
        detail: `${Math.round(chosen.share)}% of converted streams were viewers picking a lower quality in their player. Nothing to fix there.`,
      });
    }

    if (r.files.length >= 5) {
      const topTen = r.files.slice(0, 10).reduce((sum, f) => sum + f.transcodes, 0);
      const observedTranscodes = this.db
        .prepare("SELECT COUNT(*) AS n FROM stream_observations WHERE last_seen >= ? AND method = 'transcode'")
        .get(since) as { n: number };
      const allObserved = Math.max(1, observedTranscodes.n);
      const share = (topTen / allObserved) * 100;
      if (share >= 15) {
        out.push({
          weight: share,
          impact: impact(share),
          title: `10 files cause ${Math.round(share)}% of transcodes`,
          detail: 'They’re listed below. Re-encoding just those (or adding a version that plays directly) is a quick win.',
        });
      }
    }

    return out.sort((a, b) => b.weight - a.weight).map(({ weight: _w, ...s }) => s);
  }
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch {
    return [];
  }
}
