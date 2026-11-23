import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api, type AuthState } from '../lib/api';

/** The page shown until someone is fully signed in. */
export function AuthScreens({ state, onChange }: { state: AuthState; onChange: () => void }) {
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  if (recoveryCodes) {
    return (
      <Shell title="Save your recovery codes">
        {/* Stay on this screen until the app takes over, so the 2FA step never flashes back. */}
        <RecoveryCodes codes={recoveryCodes} onDone={onChange} />
      </Shell>
    );
  }
  if (state.setupRequired) return <SetupForm onDone={onChange} />;
  if (state.stage === 'enroll') return <EnrollForm username={state.user?.username ?? ''} onDone={setRecoveryCodes} onRestart={onChange} />;
  if (state.stage === 'totp') return <CodeForm onDone={onChange} onRestart={onChange} />;
  return <LoginForm onDone={onChange} />;
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <span className="text-2xl font-semibold tracking-tight">Almanac</span>
        </div>
        <section className="rounded-2xl border border-line bg-panel p-6">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </section>
      </div>
    </main>
  );
}

function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t reach Almanac. Check your connection.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        {...input}
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent-dim focus:outline-none"
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-ink-faint">
          {hint}
        </p>
      )}
    </div>
  );
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
      {error}
    </p>
  );
}

function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-canvas hover:brightness-110 disabled:opacity-60"
    >
      {busy ? 'One moment…' : children}
    </button>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await api('/api/auth/login', { method: 'POST', body: { username, password } });
    onDone();
  });
  return (
    <Shell title="Sign in">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={error} />
        <SubmitButton busy={busy}>Continue</SubmitButton>
      </form>
      <p className="mt-4 text-xs text-ink-faint">
        Locked out? Run <code className="text-ink-muted">almanac-cli</code> inside the container. See the README.
      </p>
    </Shell>
  );
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    if (password !== confirm) throw new ApiError('The passwords don’t match.', 400);
    await api('/api/auth/setup', { method: 'POST', body: { setupCode, username, password } });
    onDone();
  });
  return (
    <Shell title="Welcome to Almanac" subtitle="Create the first account. You’ll set up two-factor authentication next.">
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Setup code"
          hint="Printed in Almanac’s log when it starts, e.g. docker logs almanac"
          autoComplete="off"
          autoFocus
          required
          value={setupCode}
          onChange={(e) => setSetupCode(e.target.value)}
          placeholder="XXXX-XXXX-XXXX"
        />
        <Field label="Username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters. A long passphrase is easiest."
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field label="Password again" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <ErrorText error={error} />
        <SubmitButton busy={busy}>Create account</SubmitButton>
      </form>
    </Shell>
  );
}

/** Six-digit code input that submits as soon as six digits are typed. */
function CodeInput({ value, onChange, onComplete }: { value: string; onChange: (v: string) => void; onComplete: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <input
      ref={ref}
      aria-label="6-digit code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]*"
      maxLength={7}
      placeholder="123 456"
      value={value}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
        onChange(digits);
        if (digits.length === 6) setTimeout(onComplete, 0);
      }}
      className="w-full rounded-lg border border-line bg-canvas px-3 py-3 text-center font-mono text-2xl tracking-[0.4em] placeholder:text-ink-faint focus:border-accent-dim focus:outline-none"
    />
  );
}

function CodeForm({ onDone, onRestart }: { onDone: () => void; onRestart: () => void }) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const { busy, error, submit } = useSubmit(async () => {
    try {
      await api('/api/auth/verify', { method: 'POST', body: useRecovery ? { recoveryCode: recovery } : { code } });
      onDone();
    } catch (err) {
      setCode('');
      // Too many wrong codes ends the pending sign-in; go back to the password.
      if (err instanceof ApiError && /sign in with your password|expired/i.test(err.message)) setTimeout(onRestart, 1500);
      throw err;
    }
  });

  return (
    <Shell
      title="Two-factor authentication"
      subtitle={useRecovery ? 'Enter one of your recovery codes. Each one works once.' : 'Enter the 6-digit code from your authenticator app.'}
    >
      <form ref={formRef} onSubmit={submit} className="space-y-4">
        {useRecovery ? (
          <Field label="Recovery code" autoComplete="off" autoFocus required placeholder="xxxx-xxxx-xxxx" value={recovery} onChange={(e) => setRecovery(e.target.value)} />
        ) : (
          <CodeInput value={code} onChange={setCode} onComplete={() => formRef.current?.requestSubmit()} />
        )}
        <ErrorText error={error} />
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
      <div className="mt-4 flex justify-between text-sm">
        <button type="button" onClick={() => setUseRecovery(!useRecovery)} className="text-accent hover:underline">
          {useRecovery ? 'Use my authenticator app' : 'Use a recovery code'}
        </button>
        <button
          type="button"
          onClick={() => void api('/api/auth/logout', { method: 'POST' }).finally(onRestart)}
          className="text-ink-muted hover:text-ink"
        >
          Start again
        </button>
      </div>
    </Shell>
  );
}

function EnrollForm({ username, onDone, onRestart }: { username: string; onDone: (codes: string[]) => void; onRestart: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qrSvg: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [showKey, setShowKey] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    api<{ secret: string; otpauthUrl: string; qrSvg: string }>('/api/auth/enroll')
      .then(setSetup)
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : 'Couldn’t start 2FA setup.'));
  }, []);

  const { busy, error, submit } = useSubmit(async () => {
    try {
      const result = await api<{ recoveryCodes: string[] }>('/api/auth/enroll', { method: 'POST', body: { code } });
      onDone(result.recoveryCodes);
    } catch (err) {
      setCode('');
      throw err;
    }
  });

  return (
    <Shell
      title="Set up two-factor authentication"
      subtitle={`Every sign-in to Almanac${username ? ` as ${username}` : ''} needs a code from an authenticator app as well as your password.`}
    >
      {loadError ? (
        <>
          <ErrorText error={loadError} />
          <button type="button" onClick={onRestart} className="mt-4 text-sm text-accent hover:underline">
            Start again
          </button>
        </>
      ) : (
        <ol className="space-y-5 text-sm">
          <li>
            <p className="font-medium">1. Scan this with your authenticator app</p>
            <p className="mt-0.5 text-ink-muted">For example Google Authenticator, Microsoft Authenticator, Authy, 1Password or Bitwarden.</p>
            <div className="mt-3 flex justify-center">
              {setup ? (
                <img
                  src={`data:image/svg+xml;base64,${btoa(setup.qrSvg)}`}
                  alt="QR code for your authenticator app"
                  className="h-48 w-48 rounded-lg bg-white p-2"
                />
              ) : (
                <div className="h-48 w-48 animate-pulse rounded-lg bg-panel-raised" />
              )}
            </div>
            {setup && (
              <div className="mt-2 text-center">
                {showKey ? (
                  <div>
                    <p className="text-xs text-ink-muted">Or type this key into the app (time-based):</p>
                    <code className="mt-1 block select-all break-all rounded bg-canvas px-2 py-1.5 font-mono text-xs text-ink">
                      {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
                    </code>
                  </div>
                ) : (
                  <button type="button" onClick={() => setShowKey(true)} className="text-xs text-accent hover:underline">
                    Can’t scan it? Show the key
                  </button>
                )}
              </div>
            )}
          </li>
          <li>
            <p className="font-medium">2. Enter the 6-digit code it shows</p>
            <form ref={formRef} onSubmit={submit} className="mt-2 space-y-3">
              <CodeInput value={code} onChange={setCode} onComplete={() => formRef.current?.requestSubmit()} />
              <ErrorText error={error} />
              <SubmitButton busy={busy}>Turn on two-factor authentication</SubmitButton>
            </form>
          </li>
        </ol>
      )}
    </Shell>
  );
}

export function RecoveryCodes({ codes, onDone, doneLabel = 'Continue to Almanac' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `Almanac recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'almanac-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-ink-muted">
        If you lose your phone, each of these codes lets you sign in once instead of a 6-digit code. Store them in a password manager or
        print them. <strong className="text-ink">You won’t see them again.</strong>
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border border-line bg-canvas p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button type="button" onClick={download} className="flex-1 rounded-lg border border-line px-3 py-2 hover:border-accent-dim">
          Download
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setSaved(true);
            })
          }
          className="flex-1 rounded-lg border border-line px-3 py-2 hover:border-accent-dim"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-4 w-4 accent-accent" />
        I’ve saved these codes somewhere safe
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={onDone}
        className="w-full rounded-lg bg-accent px-4 py-2.5 font-semibold text-canvas hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {doneLabel}
      </button>
    </div>
  );
}
