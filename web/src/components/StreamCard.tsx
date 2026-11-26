import { useState } from 'react';
import type { ActivityStream } from '../../../shared/activity';
import {
  PLAY_METHOD_LABELS,
  channelsLabel,
  codecLabel,
  formatBitrate,
  formatClock,
  platformLabel,
  reasonLabel,
  titleLines,
} from '../lib/format';
import { Link } from '../lib/router';
import { MethodBadge } from './MethodBadge';
import { UserTags } from './UserTags';

interface Props {
  stream: ActivityStream;
  position: number;
  /** How many different networks this user is streaming from right now. */
  liveNetworks?: number;
}

export function StreamCard({ stream, position, liveNetworks = 1 }: Props) {
  const { title, subtitle } = titleLines(stream);
  const duration = stream.media.durationSeconds;
  const percent = duration ? Math.min(100, (position / duration) * 100) : 0;
  const { playback, video, audio, client } = stream;

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <div className="flex gap-4 p-4">
        <Poster url={stream.media.posterUrl} title={title} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-semibold text-ink" title={title}>
                {title}
              </h3>
              {subtitle && (
                <p className="truncate text-sm text-ink-muted" title={subtitle}>
                  {subtitle}
                </p>
              )}
            </div>
            <StateIcon paused={stream.progress.paused} />
          </div>

          <p className="mt-1 truncate text-sm">
            <Link to={`/users/${encodeURIComponent(stream.user.id)}`} className="font-medium text-accent hover:underline">
              {stream.user.name}
            </Link>
            {stream.user.profileName && stream.user.profileName !== 'Main' && (
              <span className="text-ink-faint"> · {stream.user.profileName}</span>
            )}{' '}
            <UserTags userId={stream.user.id} />
            {liveNetworks > 1 && (
              <span
                className="ml-1 inline-flex items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-px align-middle text-[10px] font-semibold text-ink"
                title="This account is streaming from several different networks right now"
              >
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke={liveNetworks >= 3 ? '#d03b3b' : '#fab219'} strokeWidth="1.8" aria-hidden="true">
                  <circle cx="4" cy="8" r="2.5" />
                  <circle cx="12" cy="4" r="2.5" />
                  <circle cx="12" cy="12" r="2.5" />
                </svg>
                On {liveNetworks} networks now
              </span>
            )}
          </p>

          <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-xs">
            <Row label="Stream">
              <MethodBadge method={playback.method} />
              {playback.reasons.length > 0 && (
                <span className="ml-1.5 text-ink-muted">{playback.reasons.map(reasonLabel).join(', ')}</span>
              )}
            </Row>
            <Row label="Video">
              {describeTrack(
                [video.sourceResolution, codecLabel(video.sourceCodec)],
                [video.targetResolution, codecLabel(video.targetCodec)],
                playback.videoDecision,
              )}
              {playback.hardwareAcceleration && (
                <span className="text-ink-faint"> ({playback.hardwareAcceleration.toUpperCase()})</span>
              )}
            </Row>
            <Row label="Audio">
              {describeTrack(
                [audio.language?.toUpperCase(), codecLabel(audio.sourceCodec), channelsLabel(audio.sourceChannels, audio.sourceLayout)],
                [codecLabel(audio.targetCodec), channelsLabel(audio.targetChannels)],
                playback.audioDecision,
              )}
            </Row>
            {stream.subtitle && (
              <Row label="Subtitles">
                {[stream.subtitle.language?.toUpperCase(), codecLabel(stream.subtitle.codec), stream.subtitle.forced ? 'Forced' : null]
                  .filter(Boolean)
                  .join(' ')}
                {stream.subtitle.delivery && (
                  <span className="text-ink-faint"> ({stream.subtitle.delivery.replace(/_/g, ' ')})</span>
                )}
              </Row>
            )}
            <Row label="Bandwidth">{formatBitrate(stream.bandwidth.streamKbps)}</Row>
            <Row label="Player">
              {[client.name || 'Unknown app', platformLabel(client.platform)].filter(Boolean).join(' · ')}
            </Row>
            <Row label="Location">
              <span className="text-ink">
                {client.location === 'local' ? 'Local' : 'Remote'}
              </span>
              {client.ip && <span className="text-ink-muted"> · {client.ip}</span>}
              {client.network?.operator && <span className="text-ink-muted"> · {client.network.operator}</span>}
              {client.network?.vpn && <VpnBadge />}
            </Row>
          </dl>
        </div>
      </div>

      <div className="mt-auto">
        <div className="flex justify-between px-4 pb-1.5 text-[11px] tabular-nums text-ink-faint">
          <span>{formatClock(position)}</span>
          <span>{duration ? `${formatClock(Math.max(0, duration - position))} left` : ''}</span>
          <span>{duration ? formatClock(duration) : '—'}</span>
        </div>
        <div
          className="h-1 w-full bg-panel-raised"
          role="progressbar"
          aria-label={`${PLAY_METHOD_LABELS[playback.method]} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div
            className={`h-full transition-[width] duration-1000 ease-linear ${stream.progress.paused ? 'bg-ink-faint' : 'bg-accent'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="min-w-0 truncate text-ink">{children}</dd>
    </>
  );
}

/** "1080p H.264" when direct, "2160p HEVC → 1080p H.264" when converted. */
function describeTrack(
  source: (string | null | undefined)[],
  target: (string | null | undefined)[],
  decision: string | null,
): string {
  const from = source.filter(Boolean).join(' ') || 'Unknown';
  const to = target.filter(Boolean).join(' ');
  if (decision === 'transcode' && to) return `${from} → ${to}`;
  if (decision === 'transcode') return `${from} (transcode)`;
  if (decision === 'remux' || decision === 'copy') return `${from} (copy)`;
  return from;
}

/** A VPN or data-centre connection: where it appears to be isn't where the viewer is. */
export function VpnBadge() {
  return (
    <span
      className="ml-1.5 inline-block rounded border border-[#9085e9]/60 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink"
      title="A VPN or data-centre connection: its location isn’t where the viewer is"
    >
      VPN
    </span>
  );
}

function Poster({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  const className = 'h-[132px] w-[88px] shrink-0 rounded-md bg-panel-raised object-cover';

  if (!url || failed) {
    return (
      <div className={`${className} flex items-center justify-center p-2 text-center text-[11px] leading-tight text-ink-faint`}>
        {title}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

function StateIcon({ paused }: { paused: boolean }) {
  return (
    <span
      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${paused ? 'bg-panel-raised text-ink-muted' : 'bg-accent/15 text-accent'}`}
      title={paused ? 'Paused' : 'Playing'}
    >
      {paused ? (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
          <rect x="3" y="2" width="3.5" height="12" rx="1" />
          <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="ml-0.5 h-3 w-3" fill="currentColor" aria-hidden="true">
          <path d="M4 2.5v11a1 1 0 0 0 1.5.86l9-5.5a1 1 0 0 0 0-1.72l-9-5.5A1 1 0 0 0 4 2.5Z" />
        </svg>
      )}
      <span className="sr-only">{paused ? 'Paused' : 'Playing'}</span>
    </span>
  );
}
