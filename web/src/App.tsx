import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthGate';
import { ActivityPage } from './pages/ActivityPage';
import { HistoryPage } from './pages/HistoryPage';
import { LibrariesPage } from './pages/LibrariesPage';
import { StatsPage } from './pages/StatsPage';
import { UserPage } from './pages/UserPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';
import { Link, useLocation } from './lib/router';

type Page = 'activity' | 'history' | 'stats' | 'users' | 'libraries' | 'settings';

const NAV: { label: string; path?: string; page?: Page }[] = [
  { label: 'Activity', path: '/', page: 'activity' },
  { label: 'History', path: '/history', page: 'history' },
  { label: 'Statistics', path: '/stats', page: 'stats' },
  { label: 'Users', path: '/users', page: 'users' },
  { label: 'Libraries', path: '/libraries', page: 'libraries' },
];

export function App() {
  const { pathname } = useLocation();
  const section = pathname.split('/')[1] ?? '';
  const page: Page = (['history', 'stats', 'users', 'libraries', 'settings'] as Page[]).includes(section as Page) ? (section as Page) : 'activity';
  const userId = page === 'users' ? decodeURIComponent(pathname.split('/')[2] ?? '') : '';

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 py-3 sm:gap-6 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="text-lg font-semibold tracking-tight">Almanac</span>
          </Link>
          <nav className="flex min-w-0 gap-1 overflow-x-auto text-sm" aria-label="Main">
            {NAV.map((item) => {
              if (!item.path) {
                return (
                  <span
                    key={item.label}
                    title="Coming soon"
                    className="cursor-default whitespace-nowrap rounded-md px-3 py-1.5 text-ink-faint"
                  >
                    {item.label}
                  </span>
                );
              }
              const active = item.page === page;
              return (
                <Link
                  key={item.label}
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 transition-colors ${
                    active ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <UserMenu />
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        {page === 'history' && <HistoryPage />}
        {page === 'stats' && <StatsPage />}
        {page === 'users' && (userId ? <UserPage key={userId} userId={userId} /> : <UsersPage />)}
        {page === 'libraries' && <LibrariesPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'activity' && <ActivityPage />}
      </main>
    </div>
  );
}

function UserMenu() {
  const { state, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lowOnCodes = (state.recoveryCodesLeft ?? 10) <= 2;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted hover:text-ink"
      >
        <span className="hidden sm:inline">{state.user?.username}</span>
        <span className="relative inline-flex h-7 w-7 items-center justify-center rounded-full border border-line bg-panel-raised text-[11px] font-semibold uppercase">
          {state.user?.username.slice(0, 2)}
          {lowOnCodes && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-harvest" aria-label="Running low on recovery codes" />}
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-line bg-panel-raised py-1 text-sm shadow-lg">
          <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className="block px-3 py-2 hover:bg-panel">
            Settings
            {lowOnCodes && <span className="block text-xs text-harvest">Running low on recovery codes</span>}
          </Link>
          <button type="button" role="menuitem" onClick={() => void signOut()} className="block w-full px-3 py-2 text-left hover:bg-panel">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
