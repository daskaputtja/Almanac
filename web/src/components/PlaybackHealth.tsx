import { useEffect, useState } from 'react';
import type { HealthIssue, HealthOverview, PlayerHealth, UserHealth, UserHealthResponse } from '../../../shared/health';
import { api } from '../lib/api';
import { formatRate, formatWhen, platformLabel, reasonLabel } from '../lib/format';
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
      {issue.device && (
        <div className="mt-1.5 rounded-lg border border-line bg-canvas px-3 py-2">
          <p className="text-xs font-medium uppercase tracking-wider text-ink-faint">What helps on their {issue.device.name}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-muted">
            {issue.device.tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
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
            ? `Last ${data.days} days. Each viewer is compared with other people using the same apps, since phones drop more than TVs for everyone. ${data.checked.toLocaleString()} viewers had enough plays to judge.`
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
                  <span className="w-full text-sm text-ink-muted sm:ml-auto sm:w-auto">
                    {u.issues.map((i) => KIND_LABEL[i.kind]).join(' · ')}
                    {mainDevice(u) && <span className="text-ink"> · {mainDevice(u)}</span>}
                  </span>
                </button>
                {expanded && (
                  <div className="space-y-3 px-4 pb-4">
                    <ul className="space-y-3">
                      {u.issues.map((i) => (
                        <Issue key={i.kind} issue={i} />
                      ))}
                    </ul>
                    <DeviceList user={u} />
                    <div className="flex flex-wrap items-center gap-3">
                      {u.message && <CopyMessage message={u.message} />}
                      <Link to={`/users/${encodeURIComponent(u.userId)}`} className="text-sm text-accent hover:underline">
                        Open {u.username}’s page
                      </Link>
                    </div>
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

/** The hardware a player runs on, as far as Silo knows. */
export function deviceText(p: PlayerHealth): string {
  if (p.device?.kind === 'computer') return p.device.detail ? `Computer (${p.device.detail})` : 'Computer';
  if (p.device) return p.device.kind === 'browser' && p.device.name === 'web browser' ? 'Web browser' : p.device.name;
  if (p.platform) return platformLabel(p.platform) ?? p.platform;
  return 'Unknown device';
}

/** The device behind a viewer's worst problem (most drops, or most streams). */
function mainDevice(u: UserHealth): string | null {
  const drops = u.issues.some((i) => i.kind === 'drops');
  const p = [...u.players].sort((a, b) => (drops ? b.dropped - a.dropped : b.plays - a.plays))[0];
  return p ? deviceText(p) : null;
}

/** Every device a viewer used, and the app on it, most used first. */
function DeviceList({ user }: { user: UserHealth }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-ink-faint">Their devices</p>
      <ul className="mt-1 space-y-1 text-sm">
        {user.players.map((p) => (
          <li key={`${p.label}|${p.platform ?? ''}|${p.device?.name ?? ''}|${p.device?.detail ?? ''}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{deviceText(p)}</span>
            <span className="text-ink-muted">
              {p.label}
              {p.version ? ` ${p.version}` : ''}
              {p.newerVersion && <span className="ml-1 text-xs text-[#fab219]">(newest is {p.newerVersion})</span>}
            </span>
            {!p.device?.detail && (!p.device || p.device.kind === 'computer') && (
              <span className="text-xs text-ink-faint">Silo doesn’t say which device{p.about ? `; the app is ${p.about}` : ''}</span>
            )}
            <span className="text-xs tabular-nums text-ink-faint">
              {p.plays.toLocaleString()} {p.plays === 1 ? 'stream' : 'streams'}
              {p.dropPlays ? ` · ${formatRate(p.dropped / p.dropPlays)} dropped` : ' · drops not reported'} · {formatRate(p.transcodes / p.plays)} converted
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Copy a ready-to-send message for the viewer, with a look at it first. */
function CopyMessage({ message }: { message: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showing, setShowing] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setState('copied');
    } catch {
      setState('failed');
      setShowing(true);
    }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void copy()} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim">
          {state === 'copied' ? 'Copied' : 'Copy message for the viewer'}
        </button>
        <button type="button" aria-expanded={showing} onClick={() => setShowing(!showing)} className="text-sm text-ink-muted hover:text-ink hover:underline">
          {showing ? 'Hide message' : 'Show message'}
        </button>
        {state === 'failed' && <span className="text-sm text-red-300">Your browser didn’t allow copying: select the text below instead.</span>}
      </div>
      {showing && (
        <pre className="whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 font-sans text-sm text-ink-muted">{message}</pre>
      )}
      <p className="text-xs text-ink-faint">Written to the viewer, without any of the numbers, for a Discord DM or a support ticket. Edit it as you like.</p>
    </div>
  );
}

/** One line on a user's page: what they watch on, how it's delivered, whether it's going well, and when. */
export function AtAGlance({ health, directPlayPercent, lastPlayedAt, watchingNow }: { health: UserHealthResponse | null; directPlayPercent: number | null; lastPlayedAt: string | null; watchingNow: boolean }) {
  const user = health?.user;
  const main = user ? [...user.players].sort((a, b) => b.plays - a.plays)[0] : undefined;
  const others = user ? user.players.length - 1 : 0;
  const issue = user?.issues.reduce<HealthIssue | null>((worst, i) => (!worst || rank(i) > rank(worst) ? i : worst), null) ?? null;
  const status = !health
    ? null
    : !health.enoughPlays
      ? { text: 'Too few streams to judge', color: '#737373' }
      : issue
        ? { text: KIND_LABEL[issue.kind], color: SEVERITY[issue.severity].color }
        : { text: 'Playing fine', color: '#0ca30c' };
  const delivery =
    directPlayPercent == null ? null : directPlayPercent >= 75 ? 'Mostly direct play' : directPlayPercent <= 40 ? 'Mostly converted' : `${100 - directPlayPercent}% converted`;

  const parts: React.ReactNode[] = [];
  if (main) {
    parts.push(
      <span key="device">
        <span className="font-medium text-ink">{deviceText(main)}</span>
        <span>
          {' '}
          · {main.label}
          {main.version ? ` ${main.version}` : ''}
        </span>
        {main.newerVersion && <span className="text-[#fab219]"> (update available)</span>}
        {others > 0 && <span className="text-ink-faint"> +{others} other {others === 1 ? 'device' : 'devices'}</span>}
      </span>,
    );
  }
  if (delivery) parts.push(<span key="delivery">{delivery}</span>);
  if (status) {
    parts.push(
      <span key="status" className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: status.color }} aria-hidden="true" />
        <span className="text-ink">{status.text}</span>
      </span>,
    );
  }
  parts.push(
    <span key="when">{watchingNow ? <span className="text-ink">Watching now</span> : lastPlayedAt ? `Last watched ${formatWhen(lastPlayedAt)}` : 'Never watched'}</span>,
  );
  return (
    <section aria-label="At a glance" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-ink-muted">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-3">
          {i > 0 && <span className="text-ink-faint" aria-hidden="true">·</span>}
          {p}
        </span>
      ))}
    </section>
  );
}

function rank(i: HealthIssue): number {
  return { high: 3, medium: 2, low: 1 }[i.severity];
}

/** A user's page: how playback has gone for them, by device, and what might help. */
export function UserPlaybackCard({ health }: { health: UserHealthResponse }) {
  const { user, baseline, days } = health;
  const rate = (n: number, of = user.plays) => formatRate(of ? n / of : null);
  const unjudged = user.players.filter((p) => p.dropPlays === 0);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="px-4 pt-4">
        <h2 className="text-sm font-semibold">Playback, last {days} days</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          {user.plays.toLocaleString()} streams: {rate(user.dropped, user.dropPlays)} dropped, {rate(user.quickStops)} stopped within seconds, {rate(user.transcodes)} converted.
          Across the server: {formatRate(baseline.droppedRate)}, {formatRate(baseline.quickStopRate)} and {formatRate(baseline.transcodeRate)}.
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
        {user.message && <CopyMessage message={user.message} />}
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead className="text-left text-xs text-ink-faint">
              <tr>
                <th className="px-4 py-2 font-medium">Device and app</th>
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
                    <span className="font-medium">{deviceText(p)}</span>
                    <span className="block text-xs text-ink-faint">
                      {p.label}
                      {p.version ? ` ${p.version}` : ''}
                      {p.newerVersion ? ` (newest is ${p.newerVersion})` : ''}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{p.plays.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums" title={p.dropPlays ? undefined : 'This app doesn’t tell Silo when playback stops, so drops can’t be judged.'}>
                    {p.dropPlays ? formatRate(p.dropped / p.dropPlays) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatRate(p.quickStops / p.plays)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatRate(p.transcodes / p.plays)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {unjudged.length > 0 && (
          <p className="text-xs text-ink-faint">
            {[...new Set(unjudged.map((p) => p.label))].join(', ')} {unjudged.length === 1 ? 'doesn’t' : 'don’t'} tell Silo when playback stops (every stream
            looks dropped, even finished ones), so drops there aren’t counted.
          </p>
        )}
        {user.reasons.length > 0 && (
          <p className="text-xs text-ink-faint">Converted because of: {user.reasons.map((r) => `${reasonLabel(r.reason).toLowerCase()} (${r.streams})`).join(', ')}.</p>
        )}
      </div>
    </section>
  );
}
