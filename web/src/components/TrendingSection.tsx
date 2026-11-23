import { useEffect, useState } from 'react';
import type { TrendingItem, TrendingResponse } from '../../../shared/trending';
import { api } from '../lib/api';

/** Trending at the top of the Libraries page: rising, most watched and being binged. */
export function TrendingSection() {
  const [data, setData] = useState<TrendingResponse | null>(null);
  useEffect(() => {
    api<TrendingResponse>('/api/trending').then(setData).catch(() => {});
  }, []);
  if (!data || (!data.rising.length && !data.popular.length && !data.binging.length)) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Trending</h2>
      {data.rising.length > 0 && (
        <Row title="Rising this week" subtitle="More viewers than the week before">
          {data.rising.map((i) => (
            <Card key={i.key} item={i} badge={i.changePercent == null ? 'New' : `▲ ${i.changePercent}%`} line={`${i.viewers} viewers`} />
          ))}
        </Row>
      )}
      {data.popular.length > 0 && (
        <Row title="Most watched this week" subtitle="By number of different viewers">
          {data.popular.map((i, n) => (
            <Card key={i.key} item={i} badge={`#${n + 1}`} line={`${i.viewers} viewers · ${i.plays} plays`} />
          ))}
        </Row>
      )}
      {data.binging.length > 0 && (
        <Row title="Binging right now" subtitle="Several episodes each in the last 48 hours">
          {data.binging.map((i) => (
            <Card key={i.key} item={i} badge={`${i.episodesPerViewer} eps each`} line={`${i.viewers} ${i.viewers === 1 ? 'viewer' : 'viewers'}`} />
          ))}
        </Row>
      )}
    </section>
  );
}

function Row({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-ink-faint">{subtitle}</span>
      </div>
      <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">{children}</ul>
    </div>
  );
}

function Card({ item, badge, line }: { item: TrendingItem; badge: string; line: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <li className="w-28 shrink-0 snap-start sm:w-32">
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg border border-line bg-panel-raised">
        {item.posterUrl && !failed ? (
          <img src={item.posterUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-[11px] text-ink-faint">{item.title}</div>
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-canvas/85 px-1.5 py-px text-[10px] font-semibold text-ink">{badge}</span>
      </div>
      <p className="mt-1.5 truncate text-sm font-medium" title={item.title}>
        {item.title}
      </p>
      <p className="truncate text-xs text-ink-muted">{line}</p>
    </li>
  );
}
