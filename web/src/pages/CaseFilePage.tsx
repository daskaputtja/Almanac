import { useEffect, useState } from 'react';
import { type CaseFile, coveredByException, GROUP_LABELS, type ModerationFlag } from '../../../shared/moderation';
import type { SuspensionRequest } from '../../../shared/suspensions';
import { exceptionEnds, exceptionScope, ExceptionRow } from '../components/Exceptions';
import { SeverityBadge } from '../components/FlagCard';
import { Stat } from '../components/StatsSections';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';
import { FlagText } from '../lib/moderation';
import { Link } from '../lib/router';

const SUSPENSION_STATUS: Record<SuspensionRequest['status'], string> = {
  pending: 'Waiting for an admin',
  rejected: 'Rejected',
  done: 'Done',
  failed: 'Didn’t go through',
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
/** Flag text marks times as {{time:ISO}}; plain text needs them spelled out. */
const plain = (text: string) => text.replace(/\{\{time:([^}]+)\}\}/g, (_, iso: string) => when(iso));

/** /users/:id/case — one account's whole moderation history, for mods and admins. */
export function CaseFilePage({ userId }: { userId: string }) {
  const [file, setFile] = useState<CaseFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<CaseFile>(`/api/moderation/users/${encodeURIComponent(userId)}/case`)
      .then(setFile)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Couldn’t load the case file.'));
  }, [userId]);

  if (error) return <p className="py-16 text-center text-sm text-red-300">{error}</p>;
  if (!file) return <p className="py-16 text-center text-sm text-ink-muted">Loading…</p>;
  const { user, summary } = file;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText(file));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Your browser didn’t allow copying.');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Link to={`/users/${encodeURIComponent(user.id)}`} className="text-sm text-accent hover:underline">
          ← {user.username}’s page
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Case file: {user.username}</h1>
            <p className="break-all text-sm text-ink-muted">
              {[
                user.email,
                !user.inSilo ? 'No longer in Silo' : user.enabled === false ? 'Disabled in Silo' : 'Active in Silo',
                user.createdAt ? `joined ${day(user.createdAt)}` : null,
                summary.lastPlayedAt ? `last played ${formatWhen(summary.lastPlayedAt)}` : 'never played',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {user.tags.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {user.tags.map((t) => (
                  <span key={t} className="rounded-full border border-accent-dim/60 bg-accent/10 px-2 py-0.5 text-xs">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={() => void copy()} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim">
            {copied ? 'Copied' : 'Copy as text'}
          </button>
        </div>
      </div>

      {summary.pendingRequest && (
        <p className="rounded-xl border border-[#fab219]/60 bg-panel px-4 py-3 text-sm">A suspension request for this account is waiting for an admin.</p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Open flags" value={summary.openFlags.toLocaleString()} detail={`${summary.flagsEver.toLocaleString()} on record`} />
        <Stat label="Suspended" value={summary.suspensions ? `${summary.suspensions}×` : 'Never'} />
        <Stat label="Exceptions" value={summary.exceptions ? summary.exceptions.toLocaleString() : 'None'} />
        <Stat label="Notes" value={summary.notes.toLocaleString()} />
        <Stat label="Plays, last 30 days" value={summary.plays30Days.toLocaleString()} />
        <Stat label="Downloads, last 30 days" value={summary.downloads30Days.toLocaleString()} />
      </div>

      {file.exceptions.length > 0 && (
        <Section title="Exceptions">
          <ul className="space-y-1.5">
            {file.exceptions.map((e) => (
              <ExceptionRow key={e.group} e={e} />
            ))}
          </ul>
        </Section>
      )}

      <Section title="Suspensions" empty={file.suspensions.length === 0 ? 'No suspension requests.' : undefined}>
        <ul className="space-y-2">
          {file.suspensions.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{r.action === 'suspend' ? 'Suspend' : 'Lift suspension'}</span>
                <span className="text-ink-muted">· {SUSPENSION_STATUS[r.status]}</span>
                <span className="ml-auto text-xs text-ink-faint">{when(r.requestedAt)}</span>
              </div>
              <p className="mt-0.5 text-ink-muted">
                Asked by {r.requestedBy}: “{r.reason}”
              </p>
              {r.reviewedBy && (
                <p className="text-ink-muted">
                  {r.status === 'rejected' ? 'Rejected' : 'Approved'} by {r.reviewedBy}
                  {r.reviewedAt ? ` ${formatWhen(r.reviewedAt)}` : ''}
                  {r.reviewNote ? `: “${r.reviewNote}”` : ''}
                </p>
              )}
              {r.portalMessage && <p className="text-xs text-ink-faint">Billing portal: {r.portalMessage}</p>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Flags" empty={file.flags.length === 0 ? 'Never flagged.' : undefined}>
        <ul className="space-y-2">
          {file.flags.map((f) => (
            <FlagRow key={f.id} f={f} />
          ))}
        </ul>
      </Section>

      <Section title="Timeline" empty={file.timeline.length === 0 ? 'Nothing yet.' : undefined}>
        <ol className="relative space-y-3 border-l border-line pl-4">
          {file.timeline.map((e, i) => (
            <li key={i} className="relative">
              <span
                className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-panel"
                style={{ background: e.kind === 'flag' ? (e.severity === 'high' ? '#d03b3b' : e.severity === 'medium' ? '#ec835a' : '#fab219') : 'var(--color-ink-faint)' }}
                aria-hidden="true"
              />
              <p className="text-xs text-ink-faint">
                {when(e.at)}
                {e.by ? ` · ${e.by}` : ''}
                {e.kind === 'flag' ? ' · Almanac' : ''}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm">{e.title}</p>
              {e.detail && <p className="text-xs text-ink-muted">{e.detail}</p>}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function Section({ title, children, empty }: { title: string; children: React.ReactNode; empty?: string }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {empty ? <p className="text-sm text-ink-faint">{empty}</p> : children}
    </section>
  );
}

function FlagRow({ f }: { f: ModerationFlag }) {
  return (
    <li className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <span className="text-xs uppercase tracking-wider text-ink-faint">{GROUP_LABELS[f.group].title}</span>
        <span className="ml-auto text-xs text-ink-faint">
          {day(f.firstSeenAt)} – {f.active ? 'now' : day(f.lastSeenAt)}
        </span>
      </div>
      <p className="mt-1 font-medium">{f.headline}</p>
      <ul className="text-ink-muted">
        {f.details.map((d, i) => (
          <li key={i}>
            <FlagText text={d} />
          </li>
        ))}
        {f.adminDetails.map((d, i) => (
          <li key={`a${i}`} className="text-ink-faint">
            <span className="mr-1 rounded border border-line px-1 text-[10px] uppercase">Admin</span>
            {d}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-ink-faint">
        {f.status === 'reviewed' && f.review ? `Reviewed by ${f.review.by} ${formatWhen(f.review.at)}${f.review.note ? `: “${f.review.note}”` : ''}` : f.active ? 'Open' : coveredByException(f) ? 'Hidden by the exception for this kind of flag' : 'Stopped before anyone reviewed it'}
      </p>
    </li>
  );
}

/** The case file as plain text, to paste into Discord, an email or the billing portal. Leaves out admin-only details. */
function asText(file: CaseFile): string {
  const { user, summary } = file;
  const lines: string[] = [];
  lines.push(`Case file: ${user.username}${user.email ? ` (${user.email})` : ''}`);
  lines.push(
    [
      !user.inSilo ? 'No longer in Silo' : user.enabled === false ? 'Disabled in Silo' : 'Active in Silo',
      user.createdAt ? `joined ${day(user.createdAt)}` : null,
      summary.lastPlayedAt ? `last played ${day(summary.lastPlayedAt)}` : null,
      user.tags.length ? `tags: ${user.tags.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  lines.push(
    `${summary.openFlags} open flags (${summary.flagsEver} on record) · suspended ${summary.suspensions}× · ${summary.plays30Days} plays and ${summary.downloads30Days} downloads in the last 30 days`,
  );
  if (summary.pendingRequest) lines.push('A suspension request is waiting for an admin.');

  if (file.exceptions.length) {
    lines.push('', 'Exceptions');
    for (const e of file.exceptions) lines.push(`- ${GROUP_LABELS[e.group].title}: ${exceptionScope(e.upTo).toLowerCase()}, ${exceptionEnds(e.expiresAt)}. ${e.addedBy}: “${e.reason}”`);
  }
  if (file.suspensions.length) {
    lines.push('', 'Suspensions');
    for (const r of file.suspensions) {
      lines.push(
        `- ${day(r.requestedAt)} ${r.action === 'suspend' ? 'Suspend' : 'Lift suspension'} (${SUSPENSION_STATUS[r.status].toLowerCase()}), asked by ${r.requestedBy}: “${r.reason}”` +
          (r.reviewedBy ? `; ${r.status === 'rejected' ? 'rejected' : 'approved'} by ${r.reviewedBy}${r.reviewNote ? `: “${r.reviewNote}”` : ''}` : ''),
      );
    }
  }
  if (file.flags.length) {
    lines.push('', 'Flags');
    for (const f of file.flags) {
      lines.push(`- ${day(f.firstSeenAt)}–${f.active ? 'now' : day(f.lastSeenAt)} [${GROUP_LABELS[f.group].title}] ${f.headline}${f.status === 'reviewed' && f.review ? ` (reviewed by ${f.review.by})` : ''}`);
      for (const d of f.details) lines.push(`    ${plain(d)}`);
    }
  }
  if (file.timeline.length) {
    lines.push('', 'Timeline');
    for (const e of file.timeline) lines.push(`- ${when(e.at)}${e.by ? ` ${e.by}` : ''}: ${e.title}`);
  }
  return lines.join('\n');
}
