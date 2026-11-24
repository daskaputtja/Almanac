import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '../../../shared/permissions';
import { ApiError, api } from '../lib/api';
import { formatWhen } from '../lib/format';

interface Account {
  id: number;
  username: string;
  role: Role;
  totpEnabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/** An account change waiting for the admin's 2FA code. */
interface PendingAction {
  title: string;
  /** Extra input the action needs, e.g. a new password. */
  needsPassword?: boolean;
  danger?: boolean;
  run: (code: string, password: string) => Promise<void>;
}

const input = 'rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent-dim focus:outline-none';

/** Settings → Accounts: admins add, change and remove Almanac accounts. */
export function AccountsSection({ onSelfChanged }: { onSelfChanged: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<{ accounts: Account[]; currentId: number }>('/api/auth/accounts')
      .then((d) => {
        setAccounts(d.accounts);
        setCurrentId(d.currentId);
      })
      .catch((err: unknown) => setNotice({ ok: false, text: err instanceof ApiError ? err.message : 'Couldn’t load accounts.' }));
  }, []);
  useEffect(load, [load]);

  const finish = (text: string, self = false) => {
    setPending(null);
    setNotice({ ok: true, text });
    load();
    if (self) onSelfChanged();
  };

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Accounts</h2>
          <p className="mt-1 text-sm text-ink-muted">Who can sign in to Almanac. Changes need a code from your authenticator app.</p>
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110">
            Add account
          </button>
        )}
      </div>

      <dl className="mt-3 grid gap-1 text-xs text-ink-muted sm:grid-cols-2">
        {ROLES.map((r) => (
          <div key={r}>
            <dt className="inline font-medium text-ink">{ROLE_LABELS[r]}:</dt> <dd className="inline">{ROLE_DESCRIPTIONS[r]}</dd>
          </div>
        ))}
      </dl>

      {notice && <p className={`mt-3 text-sm ${notice.ok ? 'text-ink' : 'text-red-300'}`}>{notice.text}</p>}

      {adding && (
        <AddAccountForm
          onCancel={() => setAdding(false)}
          onSubmit={(username, password, role) =>
            setPending({
              title: `Add ${username} as ${ROLE_LABELS[role].toLowerCase()}`,
              run: async (code) => {
                await api('/api/auth/accounts', { method: 'POST', body: { code, username, password, role } });
                setAdding(false);
                finish(`Added ${username}. Give them their password; they’ll set up 2FA when they first sign in.`);
              },
            })
          }
        />
      )}

      {pending && <ConfirmPanel action={pending} onCancel={() => setPending(null)} />}

      <div className="relative mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs text-ink-faint">
            <tr>
              <th className="py-2 pr-3 font-medium">Account</th>
              <th className="py-2 pr-3 font-medium">Role</th>
              <th className="py-2 pr-3 font-medium">2FA</th>
              <th className="py-2 pr-3 font-medium">Last active</th>
              <th className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {accounts?.map((a) => {
              const self = a.id === currentId;
              return (
                <tr key={a.id} className="border-t border-line/60">
                  <td className="py-2.5 pr-3 font-medium">
                    {a.username}
                    {self && <span className="ml-2 text-xs font-normal text-ink-faint">(you)</span>}
                  </td>
                  <td className="py-2.5 pr-3">
                    <select
                      aria-label={`Role for ${a.username}`}
                      value={a.role}
                      onChange={(e) => {
                        const role = e.target.value as Role;
                        setPending({
                          title: `Make ${self ? 'yourself' : a.username} ${role === 'admin' ? 'an admin' : 'a mod'}`,
                          danger: self && role !== 'admin',
                          run: async (code) => {
                            await api(`/api/auth/accounts/${a.id}/role`, { method: 'POST', body: { code, role } });
                            finish(`${a.username} is now ${role === 'admin' ? 'an admin' : 'a mod'}.`, self);
                          },
                        });
                      }}
                      className={`${input} py-1`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5 pr-3 text-ink-muted">{a.totpEnabled ? 'On' : 'Not set up yet'}</td>
                  <td className="py-2.5 pr-3 text-ink-muted">{a.lastSeenAt ? formatWhen(a.lastSeenAt) : 'Never'}</td>
                  <td className="py-2.5 text-right">
                    <div className="flex justify-end gap-1.5 text-xs">
                      <SmallButton
                        onClick={() =>
                          setPending({
                            title: `Reset ${a.username}’s two-factor authentication`,
                            run: async (code) => {
                              await api(`/api/auth/accounts/${a.id}/reset-2fa`, { method: 'POST', body: { code } });
                              finish(`${a.username} is signed out and will set up 2FA again at their next sign-in.`, self);
                            },
                          })
                        }
                      >
                        Reset 2FA
                      </SmallButton>
                      <SmallButton
                        onClick={() =>
                          setPending({
                            title: `Set a new password for ${a.username}`,
                            needsPassword: true,
                            run: async (code, password) => {
                              await api(`/api/auth/accounts/${a.id}/password`, { method: 'POST', body: { code, password } });
                              finish(`New password set for ${a.username}. They’ve been signed out everywhere.`, self);
                            },
                          })
                        }
                      >
                        Set password
                      </SmallButton>
                      {!self && (
                        <SmallButton
                          danger
                          onClick={() =>
                            setPending({
                              title: `Delete ${a.username}’s account`,
                              danger: true,
                              run: async (code) => {
                                await api(`/api/auth/accounts/${a.id}/delete`, { method: 'POST', body: { code } });
                                finish(`Deleted ${a.username}.`);
                              },
                            })
                          }
                        >
                          Delete
                        </SmallButton>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SmallButton({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`whitespace-nowrap rounded-md border border-line px-2 py-1 ${danger ? 'hover:border-red-800 hover:text-red-200' : 'hover:border-accent-dim'}`}
    >
      {children}
    </button>
  );
}

function AddAccountForm({ onSubmit, onCancel }: { onSubmit: (username: string, password: string, role: Role) => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('mod');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(username.trim(), password, role);
      }}
      className="mt-4 grid gap-3 rounded-lg border border-line bg-canvas/40 p-4 sm:grid-cols-[1fr_1fr_auto]"
    >
      <label className="block text-sm">
        <span className="font-medium">Username</span>
        <input required autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className={`${input} mt-1 w-full`} />
      </label>
      <label className="block text-sm">
        <span className="font-medium">Starting password</span>
        <input
          required
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={`${input} mt-1 w-full`}
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium">Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={`${input} mt-1 block w-full`}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-ink-faint sm:col-span-3">
        At least 12 characters. They can change it in Settings after signing in, and they’ll set up their own 2FA at first sign-in.
      </p>
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-canvas hover:brightness-110">
          Continue
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent-dim">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ConfirmPanel({ action, onCancel }: { action: PendingAction; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action.run(code, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      role="dialog"
      aria-label={action.title}
      className={`mt-4 space-y-3 rounded-lg border p-4 ${action.danger ? 'border-red-900/70 bg-red-950/20' : 'border-accent-dim/60 bg-accent/5'}`}
    >
      <p className="font-medium">{action.title}</p>
      <div className="flex flex-wrap items-end gap-3">
        {action.needsPassword && (
          <label className="block text-sm">
            <span className="block font-medium">New password</span>
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${input} mt-1 w-56`}
            />
          </label>
        )}
        <label className="block text-sm">
          <span className="block font-medium">Your code from your authenticator app</span>
          <input
            required
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className={`${input} mt-1 w-36 font-mono tracking-widest`}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className={`rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-60 ${action.danger ? 'bg-red-700 text-white hover:bg-red-600' : 'bg-accent text-canvas hover:brightness-110'}`}
        >
          Confirm
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-line px-3 py-2 text-sm hover:border-accent-dim">
          Cancel
        </button>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
    </form>
  );
}
