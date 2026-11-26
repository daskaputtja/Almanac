import { useCallback, useEffect, useState } from 'react';
import { MIN_REASON_LENGTH, type BillingPortalSettings, type SuspensionAction, type SuspensionRequest, type SuspensionsResponse } from '../../../shared/suspensions';
import type { PortalApiSettings } from '../../../shared/portal';
import { FLAG_ALERT_LEVELS } from '../../../shared/reliability';
import { useAuth } from '../auth/AuthGate';
import { ApiError, api } from '../lib/api';
import { formatFullDate, formatWhen } from '../lib/format';
import { useModeration } from '../lib/moderation';
import { Link } from '../lib/router';

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
export function RequestCard({ request: r, onChange, compact, showUser }: { request: SuspensionRequest; onChange: () => void; compact?: boolean; showUser?: boolean }) {
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
    <div className={`rounded-lg border bg-canvas/40 p-3 text-sm ${r.status === 'pending' ? 'border-[#fab219]/60' : 'border-line'}`}>
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
  const recent = data.requests.filter((r) => r.status !== 'pending').slice(0, showAll ? 50 : 3);
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
        {pending.map((r) => (
          <RequestCard key={r.id} request={r} onChange={changed} showUser />
        ))}
        {recent.length > 0 && <p className="pt-1 text-xs font-medium uppercase tracking-wide text-ink-faint">Recent</p>}
        {recent.map((r) => (
          <RequestCard key={r.id} request={r} onChange={changed} showUser compact />
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
        Suspensions go through your billing portal, which turns the Silo account off and back on, as it does for non-payment. Almanac sends it a signed
        request; the portal’s side is described in the README’s “Billing portal” section.
      </p>
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
      <PortalApiSettingsPart portalReady={Boolean(settings.url && settings.secretSet)} />
    </section>
  );
}

/** The other direction: a key the portal uses to call Almanac, and which flags are sent to it. */
function PortalApiSettingsPart({ portalReady }: { portalReady: boolean }) {
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
      {message && <p className={`text-sm ${message.ok ? 'text-ink-muted' : 'text-red-200'}`}>{message.text}</p>}
    </div>
  );
}
