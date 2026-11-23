import { useEffect, useState } from 'react';
import type { HealthCheck, ServerOverview as Overview } from '../../../shared/server';
import { api } from '../lib/api';
import { useNow } from '../lib/useActivity';

/** Silo's health and library totals, above the live activity. */
export function ServerOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const now = useNow(30_000);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Overview>('/api/server/overview')
        .then((d) => !cancelled && setData(d))
        .catch(() => {});
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data) return null;

  const nodesOk = data.nodes ? data.nodes.healthy === data.nodes.total : true;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile icon={<IconPeople />} label="Profiles · 24h" value={data.profiles24h.toLocaleString()} detail="watched on this server" />
        <Tile
          icon={<IconFilm />}
          label="Total movies"
          value={data.movies.count.toLocaleString()}
          detail={data.catalogReady ? `in ${data.movies.libraries} ${data.movies.libraries === 1 ? 'library' : 'libraries'}` : 'so far · still copying from Silo…'}
        />
        <Tile
          icon={<IconTv />}
          label="Total shows"
          value={data.shows.count.toLocaleString()}
          detail={data.catalogReady ? `in ${data.shows.libraries} ${data.shows.libraries === 1 ? 'library' : 'libraries'}` : 'so far · still copying from Silo…'}
        />
      </div>

      <section aria-label="Silo server health" className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-panel p-2 sm:grid-cols-3 lg:grid-cols-5">
        <Health icon={<IconTag />} label="Version" value={data.version ?? '—'} detail={data.restartRequired ? 'Restart required' : undefined} warn={data.restartRequired} />
        <Health icon={<IconClock />} label="Uptime" value={data.startedAt ? formatUptime(now - Date.parse(data.startedAt)) : '—'} />
        <Health icon={<IconDatabase />} label="Postgres" {...healthProps(data.postgres)} />
        <Health icon={<IconBolt />} label="Redis" {...healthProps(data.redis)} />
        <Health
          icon={<IconServer />}
          label="Nodes"
          value={data.nodes ? `${data.nodes.healthy}/${data.nodes.total}` : '—'}
          detail={data.nodes ? (nodesOk ? 'healthy' : `${data.nodes.total - data.nodes.healthy} unhealthy`) : undefined}
          bad={!nodesOk}
        />
      </section>
    </div>
  );
}

function healthProps(h: HealthCheck | null): { value: string; detail?: string; bad?: boolean } {
  if (!h) return { value: '—' };
  if (!h.ok) return { value: 'Down', bad: true };
  return { value: 'OK', detail: h.latencyMs != null ? `${h.latencyMs} ms` : undefined };
}

/** 66_960_000 → "18h 36m", 3 days → "3d 4h". */
function formatUptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  return `${hours}h ${minutes % 60}m`;
}

function Tile({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-start justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-ink-faint">{label}</h2>
        <span className="text-ink-faint">{icon}</span>
      </div>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-sm text-ink-muted">{detail}</p>
    </section>
  );
}

function Health({
  icon,
  label,
  value,
  detail,
  bad,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  bad?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border border-line/70 bg-canvas/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        {icon}
        {label}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold tabular-nums">
        {(bad || warn) && (
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke={bad ? '#d03b3b' : '#fab219'} strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M8 1.5 15 14H1L8 1.5Zm0 4v4m0 2.2v.3" />
          </svg>
        )}
        {value}
      </p>
      {detail && <p className={`text-xs ${bad || warn ? 'text-ink' : 'text-ink-faint'}`}>{detail}</p>}
    </div>
  );
}

const iconProps = { viewBox: '0 0 16 16', className: 'h-3.5 w-3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const IconTag = () => (
  <svg {...iconProps}>
    <path d="M2 2h5.5L14 8.5 8.5 14 2 7.5V2Z" />
    <circle cx="5" cy="5" r="1" />
  </svg>
);
const IconClock = () => (
  <svg {...iconProps}>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 4.5V8l2.5 1.5" />
  </svg>
);
const IconDatabase = () => (
  <svg {...iconProps}>
    <ellipse cx="8" cy="3.5" rx="5.5" ry="2" />
    <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
  </svg>
);
const IconBolt = () => (
  <svg {...iconProps}>
    <path d="M9 1.5 3 9h4.5L7 14.5 13 7H8.5L9 1.5Z" />
  </svg>
);
const IconServer = () => (
  <svg {...iconProps}>
    <rect x="2" y="2" width="12" height="5" rx="1" />
    <rect x="2" y="9" width="12" height="5" rx="1" />
    <path d="M5 4.5h.01M5 11.5h.01" />
  </svg>
);
const IconPeople = () => (
  <svg {...iconProps} className="h-4 w-4">
    <circle cx="6" cy="5" r="2.5" />
    <path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 3a2.3 2.3 0 0 1 0 4.5M12.5 10c1.3.5 2 1.8 2 4" />
  </svg>
);
const IconFilm = () => (
  <svg {...iconProps} className="h-4 w-4">
    <rect x="2" y="2" width="12" height="12" rx="1.5" />
    <path d="M5 2v12M11 2v12M2 5.5h3M2 10.5h3M11 5.5h3M11 10.5h3" />
  </svg>
);
const IconTv = () => (
  <svg {...iconProps} className="h-4 w-4">
    <rect x="1.5" y="4" width="13" height="9.5" rx="1.5" />
    <path d="M5.5 1.5 8 4l2.5-2.5" />
  </svg>
);
