import { useCallback, useEffect, useMemo, useState } from 'react';
import { type FlagGroup, type FlagsResponse, GROUP_LABELS } from '../../../shared/moderation';
import { FlagCard } from '../components/FlagCard';
import { api } from '../lib/api';
import { formatWhen } from '../lib/format';
import { useModeration } from '../lib/moderation';
import { navigate, useLocation } from '../lib/router';

type Status = 'open' | 'reviewed' | 'all';
const GROUPS: FlagGroup[] = ['sharing', 'nonstop', 'ripping'];

export function ModerationPage() {
  const { search } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const status = (['open', 'reviewed', 'all'].includes(params.get('status') ?? '') ? params.get('status') : 'open') as Status;
  const group = (GROUPS as string[]).includes(params.get('group') ?? '') ? (params.get('group') as FlagGroup) : null;
  const [data, setData] = useState<FlagsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh: refreshCounts } = useModeration();

  const load = useCallback(() => {
    api<FlagsResponse>(`/api/moderation/flags?status=${status}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(() => setError('Couldn’t load flags.'));
  }, [status]);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    const q = next.toString();
    navigate(`/moderation${q ? `?${q}` : ''}`, { replace: true });
  };

  const flags = data?.flags.filter((f) => !group || f.group === group) ?? [];
  const groupCounts = Object.fromEntries(GROUPS.map((g) => [g, data?.flags.filter((f) => f.group === g).length ?? 0]));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Moderation</h1>
        <p className="text-sm text-ink-muted">
          Accounts behaving unusually over the last 7 days, checked every 5 minutes
          {data?.checkedAt && <> (last checked {formatWhen(data.checkedAt)})</>}. A flag is a reason to look, not proof.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            aria-pressed={group === g}
            onClick={() => setParam('group', group === g ? null : g)}
            className={`rounded-xl border bg-panel p-4 text-left transition-colors hover:border-harvest-dim ${group === g ? 'border-harvest' : 'border-line'}`}
          >
            <p className="text-2xl font-semibold tabular-nums">{groupCounts[g]}</p>
            <p className="text-sm font-medium">{GROUP_LABELS[g].title}</p>
            <p className="mt-1 text-xs text-ink-faint">{GROUP_LABELS[g].meaning}</p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Show">
          {(
            [
              ['open', 'To review'],
              ['reviewed', 'Reviewed'],
              ['all', 'All'],
            ] as [Status, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => setParam('status', value === 'open' ? null : value)}
              className={`rounded-md px-3 py-1.5 text-sm ${status === value ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {group && (
          <button type="button" onClick={() => setParam('group', null)} className="text-sm text-harvest hover:underline">
            Show all kinds
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}
      {data && flags.length === 0 && (
        <p className="rounded-xl border border-dashed border-line px-6 py-16 text-center text-sm text-ink-muted">
          {status === 'open' ? 'Nothing to review. 🎉' : 'No flags here.'}
        </p>
      )}
      <div className="space-y-3">
        {flags.map((f) => (
          <FlagCard
            key={f.id}
            flag={f}
            onChange={() => {
              load();
              refreshCounts();
            }}
          />
        ))}
      </div>
    </div>
  );
}
