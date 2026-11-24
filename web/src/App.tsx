import { useEffect, useRef, useState } from 'react';
import { type Permission, ROLE_LABELS } from '../../shared/permissions';
import { useAuth } from './auth/AuthGate';
import { ActivityPage } from './pages/ActivityPage';
import { HistoryPage } from './pages/HistoryPage';
import { LibrariesPage } from './pages/LibrariesPage';
import { StatsPage } from './pages/StatsPage';
import { UserPage } from './pages/UserPage';
import { ModerationPage } from './pages/ModerationPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { RecapPage } from './pages/RecapPage';
import { ServerPage } from './pages/ServerPage';
import { SettingsPage } from './pages/SettingsPage';
import { ModerationProvider, useModeration } from './lib/moderation';
import { UsersPage } from './pages/UsersPage';
import { Link, useLocation } from './lib/router';

type Page = 'activity' | 'history' | 'stats' | 'users' | 'libraries' | 'moderation' | 'notifications' | 'settings' | 'recap' | 'server';

const NAV: { label: string; path?: string; page?: Page; permission?: Permission }[] = [
  { label: 'Activity', path: '/', page: 'activity' },
  { label: 'History', path: '/history', page: 'history' },
  { label: 'Statistics', path: '/stats', page: 'stats' },
  { label: 'Users', path: '/users', page: 'users' },
  { label: 'Libraries', path: '/libraries', page: 'libraries' },
  { label: 'Server', path: '/server', page: 'server' },
  { label: 'Moderation', path: '/moderation', page: 'moderation', permission: 'moderate' },
  { label: 'Notifications', path: '/notifications', page: 'notifications', permission: 'manageNotifications' },
];

export function App() {
  return (
    <ModerationProvider>
      <Shell />
    </ModerationProvider>
  );
}

function Shell() {
  const { pathname } = useLocation();
  const { can } = useAuth();
  const { openFlags } = useModeration();
  const section = pathname.split('/')[1] ?? '';
  const page: Page = (['history', 'stats', 'users', 'libraries', 'moderation', 'notifications', 'settings', 'recap', 'server'] as Page[]).includes(section as Page) ? (section as Page) : 'activity';
  const userId = page === 'users' ? decodeURIComponent(pathname.split('/')[2] ?? '') : '';
  const userRecap = page === 'users' && pathname.split('/')[3] === 'recap';

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 py-3 sm:gap-6 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="text-lg font-semibold tracking-tight">Almanac</span>
          </Link>
          <nav className="relative flex min-w-0 gap-1 overflow-x-auto text-sm" aria-label="Main">
            {NAV.filter((item) => !item.permission || can(item.permission)).map((item) => {
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
              const active = item.page === page || (page === 'recap' && item.page === 'stats');
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
                  {item.page === 'moderation' && openFlags.open > 0 && (
                    <span
                      className="ml-1.5 rounded-full bg-panel-raised px-1.5 py-px text-[11px] font-semibold tabular-nums text-ink"
                      style={openFlags.openHigh ? { boxShadow: 'inset 0 0 0 1px #d03b3b' } : undefined}
                      title={`${openFlags.open} flags to review${openFlags.openHigh ? `, ${openFlags.openHigh} serious` : ''}`}
                    >
                      {openFlags.open}
                    </span>
                  )}
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
        {page === 'users' &&
          (userId ? userRecap ? <RecapPage key={`recap-${userId}`} userId={userId} /> : <UserPage key={userId} userId={userId} /> : <UsersPage />)}
        {page === 'recap' && <RecapPage />}
        {page === 'server' && <ServerPage />}
        {page === 'libraries' && <LibrariesPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'moderation' && (can('moderate') ? <ModerationPage /> : <ActivityPage />)}
        {page === 'notifications' && (can('manageNotifications') ? <NotificationsPage /> : <ActivityPage />)}
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
          {lowOnCodes && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-accent" aria-label="Running low on recovery codes" />}
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-lg border border-line bg-panel-raised py-1 text-sm shadow-lg">
          <p className="border-b border-line px-3 pb-2 pt-1.5 text-xs text-ink-faint">
            {state.user?.username} · {state.role ? ROLE_LABELS[state.role] : ''}
          </p>
          <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className="block px-3 py-2 hover:bg-panel">
            Settings
            {lowOnCodes && <span className="block text-xs text-accent">Running low on recovery codes</span>}
          </Link>
          <button type="button" role="menuitem" onClick={() => void signOut()} className="block w-full px-3 py-2 text-left hover:bg-panel">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
