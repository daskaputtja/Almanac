import { useCallback, useEffect, useState } from 'react';
import type { RecapShare } from '../../../shared/recap';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';

/** On a user's recap: create, copy and revoke private links to it. */
export function SharePanel({ userId, year, name }: { userId: string; year: number; name: string }) {
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<RecapShare[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ shares: RecapShare[] }>(`/api/recap/shares?user=${encodeURIComponent(userId)}`)
      .then((d) => setShares(d.shares.filter((s) => s.year === year)))
      .catch(() => {});
  }, [userId, year]);
  useEffect(load, [load]);

  const url = (s: RecapShare) => `${window.location.origin}${s.path}`;
  const copy = (s: RecapShare) =>
    void navigator.clipboard?.writeText(url(s)).then(() => {
      setCopied(s.id);
      setTimeout(() => setCopied(null), 2000);
    });

  const create = async () => {
    setError(null);
    try {
      const share = await api<RecapShare>('/api/recap/shares', { method: 'POST', body: { user: userId, year } });
      load();
      copy(share);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t create a link.');
    }
  };
  const revoke = async (id: string) => {
    await api(`/api/recap/shares/${encodeURIComponent(id)}/revoke`, { method: 'POST' }).catch(() => {});
    load();
  };

  const active = shares.filter((s) => !s.revoked);

  return (
    <section className="rounded-xl border border-line bg-panel">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="text-sm">
          <span className="font-semibold">Share this recap with {name}</span>
          <span className="ml-2 text-ink-muted">
            {active.length ? `${active.length} active ${active.length === 1 ? 'link' : 'links'}` : 'A private link they can open without signing in'}
          </span>
        </span>
        <span className="text-ink-faint" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3">
          <p className="text-sm text-ink-muted">
            Anyone with the link sees {name}’s {year} recap and nothing else: no other pages, users or years. Revoke it whenever you like.
          </p>
          <button type="button" onClick={() => void create()} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110">
            Create a link and copy it
          </button>
          {error && <p className="text-sm text-red-300">{error}</p>}
          {shares.length > 0 && (
            <ul className="divide-y divide-line/60 text-sm">
              {shares.map((s) => (
                <li key={s.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-2 ${s.revoked ? 'opacity-50' : ''}`}>
                  <code className="min-w-0 flex-1 truncate text-xs text-ink-muted">{url(s)}</code>
                  <span className="text-xs text-ink-faint">
                    by {s.createdBy} {formatWhen(s.createdAt)} · opened {s.views} {s.views === 1 ? 'time' : 'times'}
                    {s.revoked && ' · revoked'}
                  </span>
                  {!s.revoked && (
                    <span className="flex gap-2">
                      <button type="button" onClick={() => copy(s)} className="rounded-md border border-line px-2 py-1 text-xs hover:border-accent-dim">
                        {copied === s.id ? 'Copied' : 'Copy'}
                      </button>
                      <button type="button" onClick={() => void revoke(s.id)} className="rounded-md border border-line px-2 py-1 text-xs hover:border-red-800 hover:text-red-200">
                        Revoke
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
