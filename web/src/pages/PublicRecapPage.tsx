import { useEffect, useMemo, useState } from 'react';
import type { Recap } from '../../../shared/recap';
import { RecapBody, localFacts } from './RecapPage';

/** A shared recap link: one user's year, with no sign-in and nothing else. */
export function PublicRecapPage({ token }: { token: string }) {
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/public/recap/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as (Recap & { error?: string }) | null;
        if (!r.ok || !body) throw new Error(body?.error ?? 'This link doesn’t work.');
        setRecap(body);
        document.title = `${body.user?.name ?? ''}’s ${body.year} · Almanac`;
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'This link doesn’t work.'));
  }, [token]);

  const local = useMemo(() => (recap ? localFacts(recap) : null), [recap]);

  return (
    <div className="min-h-screen px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-5">
        {error && (
          <div className="py-24 text-center">
            <img src="/favicon.svg" alt="" className="mx-auto h-10 w-10" />
            <p className="mt-4 font-medium">{error}</p>
          </div>
        )}
        {!error && (!recap || !local) && <p className="py-24 text-center text-sm text-ink-muted">Gathering the year…</p>}
        {recap && local && <RecapBody recap={recap} local={local} isPublic />}
        {recap && (
          <p className="flex items-center justify-center gap-2 pt-6 text-xs text-ink-faint">
            <img src="/favicon.svg" alt="" className="h-4 w-4" /> Made with Almanac
          </p>
        )}
      </div>
    </div>
  );
}
