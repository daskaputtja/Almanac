import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthGate';
import { RecoveryCodes } from '../auth/AuthScreens';
import { ROLE_LABELS } from '../../../shared/permissions';
import { AccountsSection } from '../components/AccountsSection';
import { ThresholdsSection } from '../components/ThresholdsSection';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';

interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

export function SettingsPage() {
  const { state, refresh, can } = useAuth();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-ink-muted">
          Signed in as {state.user?.username}
          {state.role && ` (${ROLE_LABELS[state.role]})`}. Two-factor authentication is on.
        </p>
      </div>
      {can('manageAccounts') && <AccountsSection onSelfChanged={refresh} />}
      {can('configureFlags') && <ThresholdsSection />}
      <Sessions />
      <RecoverySection left={state.recoveryCodesLeft ?? 0} onChange={refresh} />
      <PasswordSection />
    </div>
  );
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A friendly name for a browser from its user agent. */
function describeBrowser(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ sessions: SessionInfo[] }>('/api/auth/account/sessions')
      .then((d) => setSessions(d.sessions))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Couldn’t load sessions.'));
  }, []);
  useEffect(load, [load]);

  const revoke = async (id: string) => {
    try {
      await api(`/api/auth/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t sign that session out.');
    }
  };

  return (
    <Card title="Where you’re signed in" description="Sign out anything you don’t recognise. Sessions end after 7 days unused, or 30 days at most.">
      {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
      <ul className="divide-y divide-line/60">
        {sessions?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {describeBrowser(s.userAgent)}
                {s.current && <span className="ml-2 rounded border border-accent-dim px-1.5 py-px text-[11px] text-accent">This device</span>}
              </p>
              <p className="text-xs text-ink-faint">
                {s.ip ?? 'Unknown address'} · signed in {formatWhen(s.createdAt)} · last active {formatWhen(s.lastSeenAt)}
              </p>
            </div>
            {!s.current && (
              <button type="button" onClick={() => void revoke(s.id)} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-red-800 hover:text-red-200">
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">Code from your authenticator app</span>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        required
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        placeholder="123456"
        className="mt-1 w-40 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-sm tracking-widest placeholder:text-ink-faint focus:border-accent-dim focus:outline-none"
      />
    </label>
  );
}

function RecoverySection({ left, onChange }: { left: number; onChange: () => void }) {
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recoveryCodes: string[] }>('/api/auth/account/recovery-codes', { method: 'POST', body: { code } });
      setCodes(result.recoveryCodes);
      setCode('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Recovery codes"
      description={`You have ${left} unused recovery ${left === 1 ? 'code' : 'codes'}. Making new ones stops the old ones working.`}
    >
      {codes ? (
        <RecoveryCodes codes={codes} doneLabel="Done" onDone={() => (setCodes(null), onChange())} />
      ) : (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <CodeField value={code} onChange={setCode} />
          <button type="submit" disabled={busy} className="rounded-lg border border-line px-4 py-2 text-sm hover:border-accent-dim disabled:opacity-60">
            Make new recovery codes
          </button>
          {error && <p className="w-full text-sm text-red-300">{error}</p>}
        </form>
      )}
    </Card>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMessage({ ok: false, text: 'The new passwords don’t match.' });
    setBusy(true);
    setMessage(null);
    try {
      await api('/api/auth/account/password', { method: 'POST', body: { currentPassword: current, newPassword: next, code } });
      setMessage({ ok: true, text: 'Password changed. Your other sessions have been signed out.' });
      setCurrent('');
      setNext('');
      setConfirm('');
      setCode('');
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  const input = 'mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm focus:border-accent-dim focus:outline-none';
  return (
    <Card title="Change password" description="Changing it signs you out everywhere else.">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-sm font-medium">Current password</span>
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">New password</span>
          <input type="password" autoComplete="new-password" minLength={12} required value={next} onChange={(e) => setNext(e.target.value)} className={input} />
          <span className="mt-1 block text-xs text-ink-faint">At least 12 characters.</span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">New password again</span>
          <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
        </label>
        <div className="sm:col-span-2">
          <CodeField value={code} onChange={setCode} />
        </div>
        {message && <p className={`text-sm sm:col-span-2 ${message.ok ? 'text-ink' : 'text-red-300'}`}>{message.text}</p>}
        <div className="sm:col-span-2">
          <button type="submit" disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-canvas hover:brightness-110 disabled:opacity-60">
            Change password
          </button>
        </div>
      </form>
    </Card>
  );
}
