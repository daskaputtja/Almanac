import { useEffect, useState } from 'react';
import type { HealthIssue, HealthOverview, UserHealthResponse } from '../../../shared/health';
import { api } from '../lib/api';
import { formatRate, platformLabel, reasonLabel } from '../lib/format';
import { Link } from '../lib/router';

const SEVERITY: Record<HealthIssue['severity'], { label: string; color: string }> = {
  high: { label: 'Rough', color: '#d03b3b' },
  medium: { label: 'Struggling', color: '#fab219' },
  low: { label: 'Worth a look', color: '#737373' },
};

const KIND_LABEL: Record<HealthIssue['kind'], string> = {
  drops: 'Streams dropping',
  slowStarts: 'Streams stopping straight away',
  transcoding: 'Nearly everything converted',
};

function SeverityPill({ severity }: { severity: HealthIssue['severity'] }) {
  const s = SEVERITY[severity];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium" style={{ borderColor: s.color }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} aria-hidden="true" />
      {s.label}
    </span>
  );
}

function Issue({ issue }: { issue: HealthIssue }) {
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityPill severity={issue.severity} />
        <span className="text-sm font-medium">{KIND_LABEL[issue.kind]}</span>
      </div>
      <p className="text-sm tabular-nums text-ink-muted">{issue.headline}</p>
      {issue.advice.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
          {issue.advice.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Server → Reliability: viewers whose streams are going badly, worst first. */
export function RoughTimeList() {
  const [data, setData] = useState<HealthOverview | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<HealthOverview>('/api/server/health')
      .then((d) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="px-4 pt-4">
        <h2 className="text-sm font-semibold">Viewers having a rough time</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          {data
            ? `Last ${data.days} days, compared with everyone else (${formatRate(data.baseline.droppedRate)} of streams drop, ${formatRate(data.baseline.transcodeRate)} are converted). ${data.checked.toLocaleString()} viewers had enough plays to judge.`
            : 'Loading…'}
        </p>
      </div>
      {data && data.users.length === 0 && <p className="px-4 py-8 text-center text-sm text-ink-faint">Nobody stands out: streams are going about as well for everyone.</p>}
      {data && data.users.length > 0 && (
        <ul className="mt-2">
          {data.users.map((u) => {
            const expanded = open === u.userId;
            const worst = u.issues.reduce((a, b) => (rank(b) > rank(a) ? b : a));
            return (
              <li key={u.userId} className="border-t border-line/60">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : u.userId)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-panel-raised/40"
                >
                  <SeverityPill severity={worst.severity} />
                  <span className="min-w-0">
                    <span className="font-medium">{u.username}</span>
                    {u.email && <span className="ml-1.5 break-all text-xs text-ink-faint">{u.email}</span>}
                  </span>
                  <span className="w-full text-sm text-ink-muted sm:ml-auto sm:w-auto">{u.issues.map((i) => KIND_LABEL[i.kind]).join(' · ')}</span>
                </button>
                {expanded && (
                  <div className="space-y-3 px-4 pb-4">
                    <ul className="space-y-3">
                      {u.issues.map((i) => (
                        <Issue key={i.kind} issue={i} />
                      ))}
                    </ul>
                    <Link to={`/users/${encodeURIComponent(u.userId)}`} className="inline-block text-sm text-accent hover:underline">
                      Open {u.username}’s page
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function rank(i: HealthIssue): number {
  return { high: 3, medium: 2, low: 1 }[i.severity];
}

/** A user's page: how playback has gone for them, by device, and what might help. */
export function UserPlaybackCard({ health }: { health: UserHealthResponse }) {
  const { user, baseline, days } = health;
  const rate = (n: number) => formatRate(user.plays ? n / user.plays : null);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="px-4 pt-4">
        <h2 className="text-sm font-semibold">Playback, last {days} days</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          {user.plays.toLocaleString()} streams: {rate(user.dropped)} dropped (usually {formatRate(baseline.droppedRate)}), {rate(user.quickStops)} stopped within
          seconds (usually {formatRate(baseline.quickStopRate)}), {rate(user.transcodes)} converted (usually {formatRate(baseline.transcodeRate)}).
        </p>
      </div>
      <div className="space-y-4 p-4">
        {!health.enoughPlays && <p className="text-sm text-ink-faint">Too few streams to say whether anything’s wrong.</p>}
        {health.enoughPlays && user.issues.length === 0 && <p className="text-sm text-ink-muted">Nothing stands out: their streams are going about as well as everyone else’s.</p>}
        {user.issues.length > 0 && (
          <ul className="space-y-3">
            {user.issues.map((i) => (
              <Issue key={i.kind} issue={i} />
            ))}
          </ul>
        )}
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead className="text-left text-xs text-ink-faint">
              <tr>
                <th className="px-4 py-2 font-medium">Player</th>
                <th className="px-4 py-2 text-right font-medium">Streams</th>
                <th className="px-4 py-2 text-right font-medium">Dropped</th>
                <th className="px-4 py-2 text-right font-medium">Within seconds</th>
                <th className="px-4 py-2 text-right font-medium">Converted</th>
              </tr>
            </thead>
            <tbody>
              {user.players.map((p) => (
                <tr key={`${p.label}|${p.platform ?? ''}`} className="border-t border-line/60">
                  <td className="px-4 py-2">
                    <span className="font-medium">{p.label}</span>
                    {p.platform && <span className="ml-1.5 text-xs text-ink-faint">{platformLabel(p.platform)}</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{p.plays.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatRate(p.dropped / p.plays)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatRate(p.quickStops / p.plays)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatRate(p.transcodes / p.plays)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {user.reasons.length > 0 && (
          <p className="text-xs text-ink-faint">Converted because of: {user.reasons.map((r) => `${reasonLabel(r.reason).toLowerCase()} (${r.streams})`).join(', ')}.</p>
        )}
      </div>
    </section>
  );
}
