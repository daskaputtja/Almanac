import { useEffect, useState } from 'react';
import {
  type FlagGroup,
  type FlagKind,
  type FlagPreview,
  type FlagThresholds,
  GROUP_LABELS,
  LEVEL_LABELS,
  type PreviewCounts,
  THRESHOLD_INFO,
  THRESHOLD_KIND,
  type ThresholdKey,
  type ThresholdsResponse,
  validateThresholds,
} from '../../../shared/moderation';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';

const GROUPS: FlagGroup[] = ['sharing', 'nonstop', 'ripping'];
const KEYS = Object.keys(THRESHOLD_INFO) as ThresholdKey[];

/** Settings → Flag thresholds (admins): adjust the account checks, with a live preview. */
export function ThresholdsSection() {
  const [saved, setSaved] = useState<ThresholdsResponse | null>(null);
  const [draft, setDraft] = useState<FlagThresholds | null>(null);
  const [preview, setPreview] = useState<FlagPreview | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ThresholdsResponse>('/api/moderation/thresholds')
      .then((r) => {
        setSaved(r);
        setDraft(r.thresholds);
      })
      .catch(() => setMessage({ ok: false, text: 'Couldn’t load the thresholds.' }));
  }, []);

  const validation = draft ? validateThresholds(draft) : null;
  const problem = typeof validation === 'string' ? validation : null;
  const changed = Boolean(saved && draft && JSON.stringify(saved.thresholds) !== JSON.stringify(draft));
  const isDefault = Boolean(saved && draft && JSON.stringify(saved.defaults) === JSON.stringify(draft));

  // Preview how many accounts the draft would flag, a moment after each change.
  useEffect(() => {
    if (!draft || problem) return;
    const id = setTimeout(() => {
      api<FlagPreview>('/api/moderation/thresholds/preview', { method: 'POST', body: { thresholds: draft } })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(id);
  }, [draft, problem]);

  const update = (key: ThresholdKey, change: Partial<FlagThresholds[ThresholdKey]>) => {
    if (!draft) return;
    setMessage(null);
    setDraft({ ...draft, [key]: { ...draft[key], ...change } });
  };

  const save = async () => {
    if (!draft || problem) return;
    setBusy(true);
    try {
      const result = await api<ThresholdsResponse>('/api/moderation/thresholds', { method: 'POST', body: { thresholds: draft } });
      setSaved(result);
      setDraft(result.thresholds);
      setMessage({ ok: true, text: 'Saved. Every account has been checked again with the new thresholds.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t save.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold">Flag thresholds</h2>
      <p className="mt-1 text-sm text-ink-muted">
        When the account checks on the Moderation page flag someone. Each check looks at the last 7 days. Mods can see these but not
        change them.
      </p>
      {saved?.updatedBy && saved.updatedAt && (
        <p className="mt-1 text-xs text-ink-faint">
          Last changed by {saved.updatedBy} {formatWhen(saved.updatedAt)}.
        </p>
      )}

      {draft && (
        <div className="mt-4 space-y-5">
          {GROUPS.map((group) => (
            <fieldset key={group} className="space-y-3">
              <legend className="mb-1 flex w-full flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{GROUP_LABELS[group].title}</span>
                {preview && <GroupPreview group={group} preview={preview} />}
              </legend>
              {KEYS.filter((k) => THRESHOLD_INFO[k].group === group).map((key) => (
                <ThresholdRow key={key} id={key} value={draft[key]} onChange={(change) => update(key, change)} />
              ))}
            </fieldset>
          ))}
        </div>
      )}

      <div className="sticky bottom-0 -mx-5 mt-5 flex flex-wrap items-center gap-3 border-t border-line bg-panel px-5 pb-1 pt-4">
        {preview && !problem && (
          <p className="text-sm text-ink-muted">
            {changed ? (
              <>
                Would flag <strong className="text-ink">{plural(preview.proposed.accounts, 'account')}</strong> right now (currently{' '}
                {preview.current.accounts}).
              </>
            ) : (
              <>
                Flags <strong className="text-ink">{plural(preview.current.accounts, 'account')}</strong> right now.
              </>
            )}
          </p>
        )}
        {problem && <p className="text-sm text-red-300">{problem}</p>}
        {message && <p className={`text-sm ${message.ok ? 'text-ink' : 'text-red-300'}`}>{message.text}</p>}
        <div className="ml-auto flex gap-2">
          {!isDefault && saved && (
            <button type="button" onClick={() => setDraft(saved.defaults)} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim">
              Reset to defaults
            </button>
          )}
          {changed && saved && (
            <button type="button" onClick={() => setDraft(saved.thresholds)} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim">
              Undo changes
            </button>
          )}
          <button
            type="button"
            disabled={!changed || Boolean(problem) || busy}
            onClick={() => void save()}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save thresholds
          </button>
        </div>
      </div>
    </section>
  );
}

function ThresholdRow({
  id,
  value,
  onChange,
}: {
  id: ThresholdKey;
  value: FlagThresholds[ThresholdKey];
  onChange: (change: Partial<FlagThresholds[ThresholdKey]>) => void;
}) {
  const info = THRESHOLD_INFO[id];
  return (
    <div className={`grid gap-3 rounded-lg border border-line/70 bg-canvas/40 p-3 sm:grid-cols-[1fr_auto] ${value.enabled ? '' : 'opacity-60'}`}>
      <div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} className="h-4 w-4 accent-accent" />
          {info.label}
        </label>
        <p className="mt-0.5 pl-6 text-xs text-ink-faint">{info.description}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3 pl-6 sm:pl-0">
        {info.levels.map((level) => (
          <label key={level} className="block text-xs text-ink-muted">
            {LEVEL_LABELS[level]} at
            <span className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                inputMode="decimal"
                min={info.min}
                max={info.max}
                step={id === 'dailyHours' ? 0.5 : 1}
                disabled={!value.enabled}
                value={value[level] ?? ''}
                onChange={(e) => onChange({ [level]: e.target.value === '' ? undefined : Number(e.target.value) })}
                className="w-20 rounded-lg border border-line bg-canvas px-2 py-1 text-sm tabular-nums text-ink focus:border-accent-dim focus:outline-none"
              />
              <span className="whitespace-nowrap">+ {info.unit}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function groupTotal(counts: PreviewCounts, group: FlagGroup): number {
  const kinds = [...new Set(Object.entries(THRESHOLD_KIND).filter(([k]) => THRESHOLD_INFO[k as ThresholdKey].group === group).map(([, kind]) => kind))] as FlagKind[];
  return kinds.reduce((sum, kind) => sum + counts.byKind[kind].low + counts.byKind[kind].medium + counts.byKind[kind].high, 0);
}

function GroupPreview({ group, preview }: { group: FlagGroup; preview: FlagPreview }) {
  const now = groupTotal(preview.current, group);
  const next = groupTotal(preview.proposed, group);
  return (
    <span className="text-xs tabular-nums text-ink-muted">
      {now === next ? plural(now, 'flag') : `${now} → ${plural(next, 'flag')}`}
    </span>
  );
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** A plain-English summary of the thresholds, for the Moderation page. */
export function ThresholdSummary() {
  const [data, setData] = useState<ThresholdsResponse | null>(null);
  useEffect(() => {
    api<ThresholdsResponse>('/api/moderation/thresholds').then(setData).catch(() => {});
  }, []);
  if (!data) return null;
  return (
    <details className="rounded-xl border border-line bg-panel px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">How flags are decided</summary>
      <ul className="mt-3 space-y-1.5 text-ink-muted">
        {KEYS.map((key) => {
          const info = THRESHOLD_INFO[key];
          const t = data.thresholds[key];
          return (
            <li key={key}>
              <span className="text-ink">{info.label}:</span>{' '}
              {t.enabled ? info.levels.map((level) => `${LEVEL_LABELS[level].toLowerCase()} at ${t[level]}+ ${info.unit}`).join(', ') : 'off'}
            </li>
          );
        })}
      </ul>
      {data.updatedBy && data.updatedAt && (
        <p className="mt-2 text-xs text-ink-faint">
          Set by {data.updatedBy} {formatWhen(data.updatedAt)}. Admins can change these in Settings.
        </p>
      )}
    </details>
  );
}
