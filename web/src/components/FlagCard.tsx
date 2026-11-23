import { useState } from 'react';
import { GROUP_LABELS, type ModerationFlag, type Severity } from '../../../shared/moderation';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';
import { FlagText } from '../lib/moderation';
import { Link } from '../lib/router';
import { UserTags } from './UserTags';

/** Severity uses the status colours, always with an icon and a word, never colour alone. */
const SEVERITY: Record<Severity, { label: string; color: string; icon: string }> = {
  high: { label: 'Serious', color: '#d03b3b', icon: 'M8 1.5 15 14H1L8 1.5Zm0 4v4m0 2.2v.3' },
  medium: { label: 'Worth a look', color: '#ec835a', icon: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 3.5v4m0 2v.3' },
  low: { label: 'Minor', color: '#fab219', icon: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 7v4.5M8 4.8v.3' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-0.5 text-[11px] font-semibold text-ink">
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke={s.color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={s.icon} />
      </svg>
      {s.label}
    </span>
  );
}

export function FlagCard({ flag, onChange, showUser = true }: { flag: ModerationFlag; onChange: () => void; showUser?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const group = GROUP_LABELS[flag.group];

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body: body ?? {} });
      setReviewing(false);
      setNote('');
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={`rounded-xl border bg-panel p-4 ${flag.status === 'reviewed' ? 'border-line opacity-75' : 'border-line'}`}
      style={flag.status === 'open' ? { borderLeftColor: SEVERITY[flag.severity].color, borderLeftWidth: 3 } : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={flag.severity} />
        <span className="text-xs font-medium uppercase tracking-wider text-ink-faint">{group.title}</span>
        {!flag.active && <span className="text-xs text-ink-faint">· not seen in the last 7 days</span>}
        <span className="ml-auto text-xs text-ink-faint" title={new Date(flag.lastSeenAt).toLocaleString()}>
          Last seen {formatWhen(flag.lastSeenAt)}
        </span>
      </div>

      {showUser && (
        <p className="mt-2 text-sm">
          <Link to={`/users/${encodeURIComponent(flag.userId)}`} className="font-semibold text-harvest hover:underline">
            {flag.username}
          </Link>{' '}
          <UserTags userId={flag.userId} />
        </p>
      )}
      <h3 className="mt-1 font-semibold">{flag.headline}</h3>
      <ul className="mt-1 space-y-0.5 text-sm text-ink-muted">
        {flag.details.map((d, i) => (
          <li key={i}>
            <FlagText text={d} />
          </li>
        ))}
        {flag.adminDetails.map((d, i) => (
          <li key={`a${i}`} className="text-ink-faint">
            <span className="mr-1 rounded border border-line px-1 text-[10px] uppercase">Admin</span>
            {d}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-faint">{group.meaning}</p>

      {flag.review && (
        <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-sm text-ink-muted">
          Reviewed by <span className="text-ink">{flag.review.by}</span> {formatWhen(flag.review.at)}
          {flag.review.note && <>: “{flag.review.note}”</>}. It reopens if this gets clearly worse.
        </p>
      )}

      {reviewing ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(`/api/moderation/flags/${encodeURIComponent(flag.id)}/review`, { note });
          }}
        >
          <label className="block text-sm">
            <span className="font-medium">What did you find or do? (optional)</span>
            <textarea
              autoFocus
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Family in two houses, OK’d by admin. Or: warned them on Discord."
              className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-harvest-dim focus:outline-none"
            />
          </label>
          <p className="text-xs text-ink-faint">This is saved as a note on {flag.username} too.</p>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-harvest px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:opacity-60">
              Mark as reviewed
            </button>
            <button type="button" onClick={() => setReviewing(false)} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-harvest-dim">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {flag.status === 'open' ? (
            <button type="button" onClick={() => setReviewing(true)} className="rounded-lg border border-line px-3 py-1.5 hover:border-harvest-dim">
              Mark as reviewed
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(`/api/moderation/flags/${encodeURIComponent(flag.id)}/reopen`)}
              className="rounded-lg border border-line px-3 py-1.5 hover:border-harvest-dim"
            >
              Reopen
            </button>
          )}
          {showUser && (
            <Link to={`/users/${encodeURIComponent(flag.userId)}`} className="rounded-lg border border-line px-3 py-1.5 hover:border-harvest-dim">
              View user
            </Link>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
    </article>
  );
}
