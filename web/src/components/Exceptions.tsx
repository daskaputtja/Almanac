import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  EXCEPTION_LENGTHS,
  EXCEPTION_LEVELS,
  type ExceptionLevel,
  type FlagException,
  type FlagGroup,
  GROUP_LABELS,
  LEVEL_LABELS,
} from '../../../shared/moderation';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';
import { Link } from '../lib/router';

const GROUPS: FlagGroup[] = ['sharing', 'nonstop', 'ripping'];
const input = 'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent-dim focus:outline-none';
const primary = 'rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60';
const secondary = 'rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim disabled:opacity-60';

export function exceptionScope(upTo: ExceptionLevel): string {
  return upTo === 'medium' ? `${LEVEL_LABELS.low} and “${LEVEL_LABELS.medium}” hidden` : 'All hidden';
}

export function exceptionEnds(expiresAt: string | null): string {
  return expiresAt ? `until ${new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'until removed';
}

/** Allow an account something that would otherwise be flagged. */
export function ExceptionForm({
  userId,
  username,
  group: initialGroup,
  upTo: initialUpTo = 'medium',
  onSaved,
  onCancel,
}: {
  userId: string;
  username: string;
  group?: FlagGroup;
  upTo?: ExceptionLevel;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [group, setGroup] = useState<FlagGroup>(initialGroup ?? 'sharing');
  const [upTo, setUpTo] = useState<ExceptionLevel>(initialUpTo);
  const [days, setDays] = useState<number | null>(90);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/moderation/users/${encodeURIComponent(userId)}/exceptions`, { method: 'POST', body: { group, upTo, days, reason } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t save the exception.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-3 rounded-lg border border-line bg-canvas p-3">
      <p className="text-sm font-medium">Allow {username} something that would otherwise be flagged</p>
      {!initialGroup && (
        <label className="block text-sm">
          <span className="text-ink-muted">Kind of flag</span>
          <select value={group} onChange={(e) => setGroup(e.target.value as FlagGroup)} className={`${input} mt-1`}>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABELS[g].title}
              </option>
            ))}
          </select>
        </label>
      )}
      {initialGroup && <p className="text-sm text-ink-muted">{GROUP_LABELS[group].title}</p>}
      <fieldset className="space-y-1.5">
        <legend className="text-sm text-ink-muted">How much</legend>
        {EXCEPTION_LEVELS.map((l) => (
          <label key={l.value} className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name={`upTo-${userId}`} checked={upTo === l.value} onChange={() => setUpTo(l.value)} className="mt-1 accent-[var(--color-accent)]" />
            <span>
              {l.label}
              <span className="block text-xs text-ink-faint">{l.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        <span className="text-ink-muted">For</span>
        <select value={days ?? 'forever'} onChange={(e) => setDays(e.target.value === 'forever' ? null : Number(e.target.value))} className={`${input} mt-1`}>
          {EXCEPTION_LENGTHS.map((l) => (
            <option key={l.label} value={l.days ?? 'forever'}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-ink-muted">Why (other mods will see this)</span>
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Parents and grown-up kids in two houses, agreed with admin on Discord."
          className={`${input} mt-1`}
        />
      </label>
      <p className="text-xs text-ink-faint">This is saved as a note on {username}. Flags it covers disappear now and stay hidden until it ends.</p>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primary}>
          Add exception
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** On a user's page: their exceptions, and adding one. */
export function UserExceptions({ userId, username, onChange }: { userId: string; username: string; onChange: () => void }) {
  const [list, setList] = useState<FlagException[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ exceptions: FlagException[] }>('/api/moderation/exceptions')
      .then((d) => setList(d.exceptions.filter((e) => e.userId === userId)))
      .catch(() => {});
  }, [userId]);
  useEffect(load, [load]);

  const remove = async (e: FlagException) => {
    if (!window.confirm(`Remove the exception for ${GROUP_LABELS[e.group].title.toLowerCase()}? Those flags will show again.`)) return;
    setError(null);
    try {
      await api(`/api/moderation/users/${encodeURIComponent(userId)}/exceptions/${e.group}/remove`, { method: 'POST', body: {} });
      load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t remove it.');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-muted">Exceptions</span>
        {list?.length === 0 && !adding && <span className="text-sm text-ink-faint">None</span>}
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="text-sm text-accent hover:underline">
            Add an exception
          </button>
        )}
      </div>
      {list && list.length > 0 && (
        <ul className="space-y-1.5">
          {list.map((e) => (
            <ExceptionRow key={e.group} e={e} onRemove={() => void remove(e)} />
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {adding && (
        <ExceptionForm
          userId={userId}
          username={username}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
            onChange();
          }}
        />
      )}
    </div>
  );
}

export function ExceptionRow({ e, onRemove, showUser }: { e: FlagException; onRemove?: () => void; showUser?: boolean }) {
  return (
    <li className="rounded-lg border border-line bg-canvas px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {showUser && (
          <Link to={`/users/${encodeURIComponent(e.userId)}`} className="font-semibold text-accent hover:underline">
            {e.username}
          </Link>
        )}
        {showUser && e.email && <span className="break-all text-xs text-ink-faint">{e.email}</span>}
        <span className="font-medium">{GROUP_LABELS[e.group].title}</span>
        <span className="text-ink-muted">
          · {exceptionScope(e.upTo)} · {exceptionEnds(e.expiresAt)}
        </span>
        {onRemove && (
          <button type="button" onClick={onRemove} className="ml-auto text-xs text-ink-muted hover:text-ink hover:underline">
            Remove
          </button>
        )}
      </div>
      <p className="mt-0.5 text-ink-muted">“{e.reason}”</p>
      <p className="text-xs text-ink-faint">
        Added by {e.addedBy} {formatWhen(e.addedAt)}
      </p>
    </li>
  );
}

/** On the Moderation page: every account with an exception. */
export function ExceptionsOverview() {
  const [list, setList] = useState<FlagException[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api<{ exceptions: FlagException[] }>('/api/moderation/exceptions')
      .then((d) => setList(d.exceptions))
      .catch(() => {});
  }, []);
  if (!list || list.length === 0) return null;
  return (
    <section className="rounded-xl border border-line bg-panel">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left">
        <span className="text-sm font-semibold">
          Exceptions <span className="font-normal text-ink-muted">· {list.length} {list.length === 1 ? 'account is' : 'accounts are'} allowed something that would otherwise be flagged</span>
        </span>
        <span className="text-sm text-accent">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="space-y-1.5 px-4 pb-4">
          {list.map((e) => (
            <ExceptionRow key={`${e.userId}:${e.group}`} e={e} showUser />
          ))}
        </ul>
      )}
    </section>
  );
}
