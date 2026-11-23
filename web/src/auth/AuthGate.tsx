import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Permission } from '../../../shared/permissions';
import { SIGNED_OUT_EVENT, api, type AuthState } from '../lib/api';
import { AuthScreens } from './AuthScreens';

interface AuthContextValue {
  state: AuthState;
  /** Whether the signed-in account may do something. The server enforces this too. */
  can: (permission: Permission) => boolean;
  refresh: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthGate');
  return value;
}

/** Shows the app only to someone who is fully signed in (password and 2FA). */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    api<AuthState>('/api/auth/state')
      .then((s) => {
        setState(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(SIGNED_OUT_EVENT, refresh);
    // Notice sessions that end while the page is open (e.g. signed out elsewhere).
    const id = setInterval(refresh, 5 * 60_000);
    return () => {
      window.removeEventListener(SIGNED_OUT_EVENT, refresh);
      clearInterval(id);
    };
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    refresh();
  }, [refresh]);

  if (failed && !state) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="font-medium">Can’t reach the Almanac server.</p>
        <button type="button" onClick={refresh} className="text-sm text-accent hover:underline">
          Try again
        </button>
      </main>
    );
  }
  if (!state) return null;
  if (state.stage !== 'full') return <AuthScreens state={state} onChange={refresh} />;

  const can = (permission: Permission) => state.permissions.includes(permission);
  return <AuthContext.Provider value={{ state, can, refresh, signOut }}>{children}</AuthContext.Provider>;
}
