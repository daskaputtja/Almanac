import { useCallback, useEffect, useState } from 'react';
import { AUTO_REQUEST_KINDS, type AutoRequestSettings, MIN_REASON_LENGTH, type BillingPortalSettings, type SuspensionAction, type SuspensionRequest, type SuspensionsResponse } from '../../../shared/suspensions';
import type { PortalApiSettings } from '../../../shared/portal';
import { type FlagKind, type ThresholdKey, type ThresholdsResponse, THRESHOLD_INFO, THRESHOLD_KIND } from '../../../shared/moderation';
import { FLAG_ALERT_LEVELS } from '../../../shared/reliability';
import { useAuth } from '../auth/AuthGate';
import { ApiError, api } from '../lib/api';
import { formatFullDate, formatWhen } from '../lib/format';
import { useModeration } from '../lib/moderation';
import { Link, useLocation } from '../lib/router';

const input = 'rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent-dim focus:outline-none';
const primary = 'rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50';
const secondary = 'rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim disabled:opacity-50';

const STATUS: Record<SuspensionRequest['status'], { label: string; color: string }> = {
  pending: { label: 'Waiting for an admin', color: '#fab219' },
  done: { label: 'Done', color: '#0ca30c' },
  rejected: { label: 'Rejected', color: '#737373' },
  failed: { label: 'Failed', color: '#d03b3b' },
};

/** On a user's page: their access, any waiting request, and the button to ask for a change. */
export function SuspensionPanel({ userId, username, enabled, onChanged }: { userId: string; username: string; enabled: boolean | null; onChanged?: () => void }) {
  const { can } = useAuth();
  const { refresh: refreshCounts } = useModeration();
  const [data, setData] = useState<SuspensionsResponse | null>(null);
  const [asking, setAsking] = useState<SuspensionAction | null>(null);

  const load = useCallback(() => {
    api<SuspensionsResponse>(`/api/suspensions?user=${encodeURIComponent(userId)}`)
      .then(setData)
      .catch(() => {});
  }, [userId]);
  useEffect(load, [load]);

  if (!data) return null;
  const pending = data.requests.find((r) => r.status === 'pending');
  const latestDone = data.requests.find((r) => r.status === 'done');
  const suspendedByUs = latestDone?.action === 'suspend';
  const changed = () => {
    setAsking(null);
    load();
    refreshCounts();
    onChanged?.();
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Account access</h2>
        <span className="text-xs text-ink-muted">
          {enabled === false
            ? 'Disabled in Silo'
            : suspendedByUs
              ? 'Still active in Silo (Almanac checks every 5 minutes; the portal may take a moment)'
              : enabled
                ? 'Active in Silo'
                : 'Not in Silo'}
          {latestDone && ` · ${latestDone.action === 'suspend' ? 'suspended' : 'suspension lifted'} through Almanac ${formatWhen(latestDone.reviewedAt ?? latestDone.requestedAt)}`}
        </span>
      </div>

      {pending && (
        <div className="mt-3">
          <RequestCard request={pending} onChange={changed} />
        </div>
      )}

      {!pending && !asking && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!suspendedByUs && enabled !== false && (
            <button type="button" className={`${secondary} hover:border-red-800 hover:text-red-200`} onClick={() => setAsking('suspend')}>
              Suspend until they get in touch
            </button>
          )}
          {(suspendedByUs || enabled === false) && (
            <button type="button" className={secondary} onClick={() => setAsking('unsuspend')}>
              Lift the suspension
            </button>
          )}
          {!data.portalConfigured && <p className="w-full text-xs text-ink-faint">The billing portal isn’t connected yet{can('configureBilling') ? ': set it up in Settings.' : '. An admin can set it up.'}</p>}
        </div>
      )}

      {asking && <AskForm userId={userId} username={username} action={asking} onCancel={() => setAsking(null)} onDone={changed} />}

      {data.requests.filter((r) => r !== pending).length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-ink-muted hover:text-ink">Earlier requests ({data.requests.filter((r) => r !== pending).length})</summary>
          <div className="mt-2 space-y-2">
            {data.requests
              .filter((r) => r !== pending)
              .map((r) => (
                <RequestCard key={r.id} request={r} onChange={changed} compact />
              ))}
          </div>
        </details>
      )}
    </section>
  );
}

function AskForm({ userId, username, action, onCancel, onDone }: { userId: string; username: string; action: SuspensionAction; onCancel: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const direct = can('reviewSuspension');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = reason.trim().length < MIN_REASON_LENGTH;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<SuspensionRequest>('/api/suspensions', { method: 'POST', body: { userId, action, reason } });
      if (result.status === 'failed') setError(`Saved, but the portal didn’t do it: ${result.portalMessage ?? 'unknown error'}. You can try again below.`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t send it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded-lg border border-accent-dim bg-canvas/40 p-3">
      <p className="text-sm">
        {action === 'suspend' ? `Suspend ${username} until they get in touch.` : `Lift ${username}’s suspension.`}{' '}
        <span className="text-ink-muted">
          {direct ? 'This goes to the billing portal straight away.' : 'An admin reviews it before anything happens.'}
        </span>
      </p>
      <label className="block text-sm">
        <span className="font-medium">Reason (required)</span>
        <textarea
          required
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={action === 'suspend' ? 'For example: 123 downloads (270 GB) in a week, all original quality.' : 'For example: Spoke to them; it was a family member. Agreed to stop.'}
          className={`${input} mt-1 w-full`}
        />
        <span className="text-xs text-ink-faint">Saved in the account’s notes and sent to the billing portal.</span>
      </label>
      {error && <p className="text-sm text-red-200">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || tooShort} className={action === 'suspend' ? 'rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50' : primary}>
          {busy ? 'Sending…' : direct ? (action === 'suspend' ? 'Suspend now' : 'Lift it now') : 'Send for review'}
        </button>
        <button type="button" onClick={onCancel} className={secondary}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One request: what, why, who, and (for admins) approve, reject or retry. */
export function RequestCard({
  request: r,
  onChange,
  compact,
  showUser,
  focused,
}: {
  request: SuspensionRequest;
  onChange: () => void;
  compact?: boolean;
  showUser?: boolean;
  /** Opened from a link (a Discord button): scroll to it and highlight it. */
  focused?: boolean;
}) {
  const { can } = useAuth();
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = STATUS[r.status];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDeciding(null);
      setNote('');
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      id={`request-${r.id}`}
      ref={(el) => {
        if (el && focused && !el.dataset.scrolled) {
          el.dataset.scrolled = '1';
          el.scrollIntoView({ block: 'center' });
        }
      }}
      className={`scroll-mt-24 rounded-lg border bg-canvas/40 p-3 text-sm ${focused ? 'ring-2 ring-accent' : ''} ${r.status === 'pending' ? 'border-[#fab219]/60' : 'border-line'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <span className="h-2 w-2 rounded-full" style={{ background: status.color }} aria-hidden="true" />
          {status.label}
        </span>
        <span className="font-semibold">{r.action === 'suspend' ? 'Suspend' : 'Lift suspension'}</span>
        {showUser && (
          <span>
            <Link to={`/users/${encodeURIComponent(r.userId)}`} className="font-medium text-accent hover:underline">
              {r.username}
            </Link>
            {r.email && <span className="text-ink-muted"> · {r.email}</span>}
          </span>
        )}
        <span className="ml-auto text-xs text-ink-faint" title={formatFullDate(r.requestedAt)}>
          {r.requestedBy} · {formatWhen(r.requestedAt)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-ink">{r.reason}</p>
      {!compact || r.reviewedBy ? (
        <>
          {r.reviewedBy && (
            <p className="mt-1.5 text-xs text-ink-muted">
              {r.status === 'rejected' ? 'Rejected' : 'Approved'} by {r.reviewedBy}
              {r.reviewedAt && ` ${formatWhen(r.reviewedAt)}`}
              {r.reviewNote && `: ${r.reviewNote}`}
            </p>
          )}
          {r.portalMessage && (
            <p className={`mt-1 text-xs ${r.status === 'failed' ? 'text-red-200' : 'text-ink-faint'}`}>Billing portal: {r.portalMessage}</p>
          )}
        </>
      ) : null}

      {can('reviewSuspension') && r.status === 'pending' && !deciding && (
        <div className="mt-2.5 flex gap-2">
          <button type="button" className={primary} onClick={() => setDeciding('approve')}>
            Approve
          </button>
          <button type="button" className={secondary} onClick={() => setDeciding('reject')}>
            Reject
          </button>
        </div>
      )}
      {can('reviewSuspension') && r.status === 'failed' && (
        <button type="button" disabled={busy} className={`${secondary} mt-2.5`} onClick={() => act(() => api(`/api/suspensions/${r.id}/retry`, { method: 'POST' }))}>
          {busy ? 'Trying…' : 'Try again'}
        </button>
      )}
      {deciding && (
        <form
          className="mt-2.5 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api(`/api/suspensions/${r.id}/review`, { method: 'POST', body: { decision: deciding, note } }));
          }}
        >
          <textarea
            rows={2}
            autoFocus
            required={deciding === 'reject'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={deciding === 'reject' ? 'Why not? (required, saved in the notes)' : 'Anything to add? (optional)'}
            className={`${input} w-full`}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || (deciding === 'reject' && note.trim().length < MIN_REASON_LENGTH)}
              className={deciding === 'approve' ? (r.action === 'suspend' ? 'rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50' : primary) : primary}
            >
              {busy ? 'Sending…' : deciding === 'approve' ? (r.action === 'suspend' ? 'Approve and suspend' : 'Approve and lift it') : 'Reject'}
            </button>
            <button type="button" className={secondary} onClick={() => setDeciding(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-red-200">{error}</p>}
    </div>
  );
}

/** On the Moderation page: requests waiting for an admin, and recent decisions. */
export function SuspensionQueue() {
  const { refresh: refreshCounts } = useModeration();
  const { search } = useLocation();
  const focusId = Number(new URLSearchParams(search).get('request')) || null;
  const [data, setData] = useState<SuspensionsResponse | null>(null);
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => {
    api<SuspensionsResponse>('/api/suspensions')
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);
  if (!data || data.requests.length === 0) return null;
  const pending = data.requests.filter((r) => r.status === 'pending');
  const decided = data.requests.filter((r) => r.status !== 'pending');
  const recent = decided.slice(0, showAll ? 50 : 3);
  // A link to an older request (already dealt with) still shows it.
  const linked = focusId ? decided.find((r) => r.id === focusId) : undefined;
  if (linked && !recent.includes(linked)) recent.unshift(linked);
  const changed = () => {
    load();
    refreshCounts();
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold">
        Suspension requests{pending.length > 0 && <span className="ml-2 text-xs font-normal text-ink-muted">{pending.length} waiting for an admin</span>}
      </h2>
      <div className="mt-3 space-y-2">
        {focusId && !data.requests.some((r) => r.id === focusId) && <p className="text-sm text-ink-muted">That request isn’t in the recent list any more.</p>}
        {pending.map((r) => (
          <RequestCard key={r.id} request={r} onChange={changed} showUser focused={r.id === focusId} />
        ))}
        {recent.length > 0 && <p className="pt-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Recent</p>}
        {recent.map((r) => (
          <RequestCard key={r.id} request={r} onChange={changed} showUser compact focused={r.id === focusId} />
        ))}
      </div>
      {data.requests.filter((r) => r.status !== 'pending').length > 3 && (
        <button type="button" className="mt-2 text-sm text-accent hover:underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show fewer' : 'Show more'}
        </button>
      )}
    </section>
  );
}

/** Settings → Billing portal (admins). */
export function BillingPortalSection() {
  const [settings, setSettings] = useState<BillingPortalSettings | null>(null);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [generated, setGenerated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<BillingPortalSettings>('/api/billing-portal')
      .then((s) => {
        setSettings(s);
        setUrl(s.url ?? '');
      })
      .catch(() => {});
  }, []);

  const generate = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setSecret(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
    setGenerated(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const body: Record<string, string> = { url };
      if (secret) body.secret = secret;
      setSettings(await api<BillingPortalSettings>('/api/billing-portal', { method: 'POST', body }));
      setSecret('');
      setGenerated(false);
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t save.' });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/billing-portal/test', { method: 'POST' });
      setMessage({ ok: r.ok, text: r.ok ? `The portal answered: ${r.message}` : r.message });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold">Billing portal</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Suspensions go through your billing system, which turns the Silo account off and back on, as it does for non-payment.
      </p>
      <div className="mt-3 flex rounded-lg border border-line bg-canvas p-0.5 text-sm" role="group" aria-label="Billing system">
        {(
          [
            ['custom', 'Custom portal'],
            ['whmcs', 'WHMCS'],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            aria-pressed={settings.kind === kind}
            disabled={busy}
            onClick={() =>
              void (async () => {
                setMessage(null);
                try {
                  setSettings(await api<BillingPortalSettings>('/api/billing-portal', { method: 'POST', body: { kind } }));
                } catch (err) {
                  setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t save.' });
                }
              })()
            }
            className={`flex-1 rounded-md px-3 py-1.5 ${settings.kind === kind ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {settings.kind === 'whmcs' ? (
        <WhmcsForm settings={settings} onSaved={setSettings} />
      ) : (
      <>
      <p className="mt-3 text-sm text-ink-muted">Almanac sends your portal a signed request; the portal’s side is described in the README’s “Billing portal” section.</p>
      <form onSubmit={save} className="mt-4 space-y-3">
        <label className="block text-sm">
          <span className="font-medium">Address Almanac sends requests to</span>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://billing.example.com/almanac/suspensions" className={`${input} mt-1 w-full`} />
        </label>
        <div className="text-sm">
          <span className="font-medium">Signing secret</span>{' '}
          <span className="text-xs text-ink-muted">{settings.secretSet ? '(saved; paste or generate a new one to replace it)' : '(not set)'}</span>
          <div className="mt-1 flex flex-wrap gap-2">
            <input
              type={generated ? 'text' : 'password'}
              autoComplete="off"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setGenerated(false);
              }}
              placeholder="The same secret your portal checks requests with"
              className={`${input} min-w-0 flex-1 basis-72 font-mono`}
            />
            <button type="button" className={secondary} onClick={generate}>
              Generate one
            </button>
          </div>
          {generated && <p className="mt-1 text-xs text-[#fab219]">Copy this into your portal now. Once saved, Almanac won’t show it again.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={primary}>
            Save
          </button>
          <button type="button" disabled={busy || !settings.url || !settings.secretSet} className={secondary} onClick={() => void test()}>
            Send a test
          </button>
        </div>
        {message && <p className={`text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
        {settings.updatedBy && <p className="text-xs text-ink-faint">Last changed by {settings.updatedBy} {settings.updatedAt ? formatWhen(settings.updatedAt) : ''}</p>}
      </form>
      </>
      )}
      <PortalApiSettingsPart portalReady={settings.ready} kind={settings.kind} />
    </section>
  );
}

/** WHMCS: Almanac calls WHMCS's own API to suspend and unsuspend the customer's Silo service. */
function WhmcsForm({ settings, onSaved }: { settings: BillingPortalSettings; onSaved: (s: BillingPortalSettings) => void }) {
  const w = settings.whmcs;
  const [url, setUrl] = useState(w.url ?? '');
  const [identifier, setIdentifier] = useState(w.identifier ?? '');
  const [secret, setSecret] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [match, setMatch] = useState(w.match);
  const [productIds, setProductIds] = useState(w.productIds.join(', '));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const whmcs: Record<string, unknown> = { url, identifier, match, productIds };
      if (secret) whmcs.secret = secret;
      if (accessKey) whmcs.accessKey = accessKey;
      onSaved(await api<BillingPortalSettings>('/api/billing-portal', { method: 'POST', body: { whmcs } }));
      setSecret('');
      setAccessKey('');
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t save.' });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/billing-portal/test', { method: 'POST' });
      setMessage({ ok: r.ok, text: r.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="mt-4 space-y-3">
      <p className="text-sm text-ink-muted">
        When an admin approves a suspension, Almanac finds the customer’s Silo service in WHMCS and runs WHMCS’s own <em>Module Suspend</em> (or <em>Unsuspend</em>),
        so WHMCS’s provisioning module turns the Silo account off. In WHMCS: <strong className="font-medium text-ink">System Settings → Manage API Credentials</strong>, make
        a role allowing <code>GetClientsProducts</code>, <code>GetClientsDetails</code>, <code>ModuleSuspend</code> and <code>ModuleUnsuspend</code>, then
        credentials for it, and allow this server’s IP under <strong className="font-medium text-ink">General Settings → Security</strong>.
      </p>
      <label className="block text-sm">
        <span className="font-medium">WHMCS address</span>
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://billing.example.com" className={`${input} mt-1 w-full`} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">API identifier</span>
          <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="off" className={`${input} mt-1 w-full font-mono`} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">API secret</span> <span className="text-xs text-ink-muted">{w.secretSet ? '(saved)' : '(not set)'}</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            placeholder={w.secretSet ? 'Leave empty to keep it' : ''}
            className={`${input} mt-1 w-full font-mono`}
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="font-medium">API access key</span> <span className="text-xs text-ink-muted">(optional{w.accessKeySet ? ', saved' : ''})</span>
        <input type="password" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} autoComplete="off" className={`${input} mt-1 w-full font-mono`} />
        <span className="mt-1 block text-xs text-ink-faint">Only if you’d rather not allow this server’s IP: the access key set in WHMCS’s configuration.php.</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Match Silo accounts by</span>
          <select value={match} onChange={(e) => setMatch(e.target.value as typeof match)} className={`${input} mt-1 w-full`}>
            <option value="username_or_email">Service username, then client email</option>
            <option value="username">Service username only</option>
            <option value="email">Client email only</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Silo product IDs</span>
          <input value={productIds} onChange={(e) => setProductIds(e.target.value)} placeholder="e.g. 7, 8" className={`${input} mt-1 w-full`} />
          <span className="mt-1 block text-xs text-ink-faint">The WHMCS products that are Silo plans, so other services (domains, hosting) are never touched.</span>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primary}>
          Save
        </button>
        <button type="button" disabled={busy || !settings.ready} className={secondary} onClick={() => void test()}>
          Test the connection
        </button>
      </div>
      {message && <p className={`text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
      {!w.productIds.length && settings.ready && (
        <p className="text-xs text-[#fab219]">No product IDs set: every service the customer has would be suspended. Add your Silo products’ IDs.</p>
      )}
    </form>
  );
}

/** The other direction: a key the portal uses to call Almanac, and which flags are sent to it. */
function PortalApiSettingsPart({ portalReady, kind }: { portalReady: boolean; kind: BillingPortalSettings['kind'] }) {
  const [settings, setSettings] = useState<PortalApiSettings | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<PortalApiSettings>('/api/billing-portal/api').then(setSettings).catch(() => {});
  }, []);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;
  return (
    <div className="mt-6 space-y-3 border-t border-line pt-5">
      <h3 className="font-semibold">Portal API</h3>
      <p className="text-sm text-ink-muted">
        Lets your portal call Almanac: look a customer up by username or email (activity, devices, open flags, VPN use, playback), read usage for billing (streams
        at once, devices, hours, downloads), and tell Almanac what it did (suspended, reactivated, plan changed), which goes in the customer’s notes. It never gets
        IP addresses. The README’s “Portal API” section has the details.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{settings.keySet ? `Key ending …${settings.keyHint}, made by ${settings.createdBy ?? 'an admin'} ${settings.createdAt ? formatWhen(settings.createdAt) : ''}` : 'No key yet.'}</span>
        {settings.keySet && <span className="text-xs text-ink-faint">{settings.lastUsedAt ? `Last used ${formatWhen(settings.lastUsedAt)}` : 'Not used yet'}</span>}
      </div>
      {newKey && (
        <div className="rounded-lg border border-[#fab219]/60 bg-canvas p-3 text-sm">
          <p className="font-medium">Your portal’s key. Copy it into the portal now: Almanac won’t show it again.</p>
          <code className="mt-2 block break-all rounded bg-panel px-2 py-1.5 font-mono text-xs">{newKey}</code>
          <p className="mt-2 text-xs text-ink-muted">The portal sends it as <code>Authorization: Bearer &lt;key&gt;</code> to <code>{window.location.origin}/api/portal/v1/…</code></p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={settings.keySet ? secondary : primary}
          onClick={() =>
            void act(async () => {
              if (settings.keySet && !window.confirm('Make a new key? The old one stops working straight away.')) return;
              const r = await api<{ key: string; settings: PortalApiSettings }>('/api/billing-portal/api/key', { method: 'POST' });
              setNewKey(r.key);
              setSettings(r.settings);
            })
          }
        >
          {settings.keySet ? 'Make a new key' : 'Make a key'}
        </button>
        {settings.keySet && (
          <button
            type="button"
            disabled={busy}
            className={secondary}
            onClick={() =>
              void act(async () => {
                if (!window.confirm('Turn the key off? The portal won’t be able to call Almanac until you make a new one.')) return;
                setSettings(await api<PortalApiSettings>('/api/billing-portal/api/revoke', { method: 'POST' }));
                setNewKey(null);
              })
            }
          >
            Turn the key off
          </button>
        )}
      </div>
      {kind === 'whmcs' ? (
        <p className="text-sm text-ink-muted">
          For WHMCS, the README’s “WHMCS” section has a hook file that uses this key: it shows Almanac’s summary on each client’s page in WHMCS and tells Almanac
          when WHMCS suspends, unsuspends or changes a Silo service.
        </p>
      ) : (
      <label className="block text-sm">
        <span className="font-medium">Send new flags to the portal</span>
        <select
          value={settings.flagLevel}
          disabled={busy}
          onChange={(e) =>
            void act(async () => {
              setSettings(await api<PortalApiSettings>('/api/billing-portal/api/flags', { method: 'POST', body: { flagLevel: e.target.value } }));
              setMessage({ ok: true, text: 'Saved.' });
            })
          }
          className={`${input} mt-1 block`}
        >
          {FLAG_ALERT_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-ink-faint">
          {portalReady
            ? 'Sent to the address above, signed like suspension requests, as a “flag” event.'
            : 'Needs the address and signing secret above: flags are sent the same way as suspension requests.'}
        </span>
      </label>
      )}
      {message && <p className={`text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
    </div>
  );
}

/** Settings: which serious flags file a suspension request by themselves. An admin still approves every one. */
export function AutoRequestsSection() {
  const [settings, setSettings] = useState<AutoRequestSettings | null>(null);
  const [thresholds, setThresholds] = useState<ThresholdsResponse | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<AutoRequestSettings>('/api/suspensions/automatic').then(setSettings).catch(() => {});
    api<ThresholdsResponse>('/api/moderation/thresholds').then(setThresholds).catch(() => {});
  }, []);

  const serious = (kind: FlagKind): string => {
    if (!thresholds) return '';
    const keys = (Object.keys(THRESHOLD_KIND) as ThresholdKey[]).filter((k) => THRESHOLD_KIND[k] === kind);
    const parts = keys
      .filter((k) => thresholds.thresholds[k].enabled && thresholds.thresholds[k].high !== undefined)
      .map((k) => `${thresholds.thresholds[k].high!.toLocaleString()} ${THRESHOLD_INFO[k].unit}`);
    return parts.length ? `Serious from ${parts.join(' or ')}` : 'This check is off, or has no serious level';
  };
  const label = (kind: FlagKind) => {
    const key = (Object.keys(THRESHOLD_KIND) as ThresholdKey[]).find((k) => THRESHOLD_KIND[k] === kind)!;
    return kind === 'heavy_downloads' ? 'Offline downloads in a week' : THRESHOLD_INFO[key].label;
  };

  const toggle = async (kind: FlagKind, on: boolean) => {
    if (!settings) return;
    setMessage(null);
    try {
      const kinds = on ? [...settings.kinds, kind] : settings.kinds.filter((k) => k !== kind);
      setSettings(await api<AutoRequestSettings>('/api/suspensions/automatic', { method: 'POST', body: { kinds } }));
      setMessage({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t save.' });
    }
  };

  if (!settings) return null;
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold">Automatic suspension requests</h2>
      <p className="mt-1 text-sm text-ink-muted">
        When one of these checks reaches <strong className="font-medium text-ink">Serious</strong>, Almanac files a suspension request by itself, with the evidence as
        the reason, and tells admins on Discord and the phone. It waits for an admin like any mod’s request: nothing happens to the account until someone approves
        it. Accounts with an exception for that kind of flag are left alone. The levels are set under Account checks.
      </p>
      <ul className="mt-3 space-y-2">
        {AUTO_REQUEST_KINDS.map((kind) => (
          <li key={kind}>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.kinds.includes(kind)}
                onChange={(e) => void toggle(kind, e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                {label(kind)}
                <span className="block text-xs text-ink-faint">
                  {serious(kind)}
                  {kind === 'nonstop' || kind === 'heavy_daily' ? '. A TV left on with autoplay looks the same as restreaming, so check before approving.' : ''}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {message && <p className={`mt-2 text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
      {settings.updatedBy && (
        <p className="mt-2 text-xs text-ink-faint">
          Last changed by {settings.updatedBy} {settings.updatedAt ? formatWhen(settings.updatedAt) : ''}
        </p>
      )}
    </section>
  );
}
