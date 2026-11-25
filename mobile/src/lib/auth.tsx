import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Permission, Role } from '../../../shared/permissions';
import { api, loadCredentials, setServer, setToken, whenSignedOut } from './api';

export interface Me {
  username: string;
  role: Role;
  permissions: Permission[];
}

type Stage = 'loading' | 'connect' | 'signIn' | 'ready';

interface AuthValue {
  stage: Stage;
  server: string | null;
  me: Me | null;
  can: (permission: Permission) => boolean;
  /** After a successful sign-in, or to re-check. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Forget this server entirely and go back to the address screen. */
  disconnect: () => Promise<void>;
  setServerAddress: (url: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [stage, setStage] = useState<Stage>('loading');
  const [server, setServerState] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const refresh = useCallback(async () => {
    const saved = await loadCredentials();
    setServerState(saved.server);
    if (!saved.server) return setStage('connect');
    if (!saved.token) return setStage('signIn');
    try {
      const state = await api<{ stage: string | null; user: { username: string } | null; role: Role | null; permissions: Permission[] }>('/api/auth/state');
      if (state.stage === 'full' && state.user && state.role) {
        setMe({ username: state.user.username, role: state.role, permissions: state.permissions });
        setStage('ready');
      } else {
        await setToken(null);
        setStage('signIn');
      }
    } catch {
      // Offline or the server is down: keep the sign-in and let screens show the error.
      setStage(me ? 'ready' : 'signIn');
    }
  }, [me]);

  useEffect(() => {
    whenSignedOut(() => {
      void setToken(null);
      setMe(null);
      setStage('signIn');
    });
    void refresh();
    // Only on start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      stage,
      server,
      me,
      can: (permission) => Boolean(me?.permissions.includes(permission)),
      refresh,
      signOut: async () => {
        try {
          await api('/api/app/push', { method: 'DELETE' });
          await api('/api/auth/logout', { method: 'POST', body: {} });
        } catch {
          // Signing out locally is what matters.
        }
        await setToken(null);
        setMe(null);
        setStage('signIn');
      },
      disconnect: async () => {
        await setToken(null);
        await setServer(null);
        setMe(null);
        setServerState(null);
        setStage('connect');
      },
      setServerAddress: async (url) => {
        await setServer(url);
        setServerState(url);
        setStage('signIn');
      },
    }),
    [stage, server, me, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
