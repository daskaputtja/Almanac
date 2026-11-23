import { ActivityPage } from './pages/ActivityPage';

const NAV = [
  { label: 'Activity', active: true },
  { label: 'History', soon: true },
  { label: 'Statistics', soon: true },
  { label: 'Users', soon: true },
  { label: 'Libraries', soon: true },
];

export function App() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-4 sm:gap-6 py-3 sm:px-6">
          <div className="flex shrink-0 items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="text-lg font-semibold tracking-tight">Almanac</span>
          </div>
          <nav className="flex min-w-0 gap-1 overflow-x-auto text-sm" aria-label="Main">
            {NAV.map((item) => (
              <span
                key={item.label}
                aria-current={item.active ? 'page' : undefined}
                title={item.soon ? 'Coming soon' : undefined}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 ${
                  item.active ? 'bg-panel-raised font-medium text-ink' : 'cursor-default text-ink-faint'
                }`}
              >
                {item.label}
              </span>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        <ActivityPage />
      </main>
    </div>
  );
}
