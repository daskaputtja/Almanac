import { ActivityPage } from './pages/ActivityPage';
import { HistoryPage } from './pages/HistoryPage';
import { Link, useLocation } from './lib/router';

const NAV = [
  { label: 'Activity', path: '/' },
  { label: 'History', path: '/history' },
  { label: 'Statistics', soon: true },
  { label: 'Users', soon: true },
  { label: 'Libraries', soon: true },
];

export function App() {
  const { pathname } = useLocation();
  const page = pathname.startsWith('/history') ? 'history' : 'activity';

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
              const active = (item.path === '/' ? 'activity' : 'history') === page;
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
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        {page === 'history' ? <HistoryPage /> : <ActivityPage />}
      </main>
    </div>
  );
}
