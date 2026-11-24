import { useEffect, useState } from 'react';
import type { DownloadEntry, DownloadsResponse } from '../../../shared/accounts';
import { Stat } from '../components/StatsSections';
import { useAuth } from '../auth/AuthGate';
import { api } from '../lib/api';
import { formatBytes, formatFullDate, formatWhen } from '../lib/format';
import { Link } from '../lib/router';

/** Server → Downloads: what people have downloaded to their devices for offline viewing. */
export function DownloadsTab() {
  const [data, setData] = useState<DownloadsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<DownloadsResponse>('/api/downloads')
        .then((d) => !cancelled && setData(d))
        .catch(() => !cancelled && setError('Couldn’t load downloads.'));
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) return <p className="py-16 text-center text-sm text-red-200">{error}</p>;
  if (!data) return <p className="py-16 text-center text-sm text-ink-muted">Loading…</p>;
  const { totals } = data;

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-muted">
        Movies and episodes people have downloaded in Silo’s apps to watch offline. Downloads are full copies of the file, so lots of them in a short time
        is worth a look; the Moderation page flags it automatically.
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="On devices now" value={totals.onDevices.toLocaleString()} detail={formatBytes(totals.onDevicesBytes)} />
        <Stat label="Accounts with downloads" value={totals.accountsWithDownloads.toLocaleString()} />
        <Stat label="Last 7 days" value={totals.last7Days.toLocaleString()} detail={formatBytes(totals.last7DaysBytes)} />
        <Stat label="Last 30 days" value={totals.last30Days.toLocaleString()} detail={formatBytes(totals.last30DaysBytes)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[2fr_3fr]">
        <section className="overflow-hidden rounded-xl border border-line bg-panel">
          <h2 className="px-4 pt-4 text-sm font-semibold">Most downloads, last 30 days</h2>
          {data.topUsers.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-faint">Nobody has downloaded anything in the last 30 days.</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs text-ink-faint">
                <tr>
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 text-right font-medium">Downloads</th>
                  <th className="px-4 py-2 text-right font-medium">Size</th>
                  <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Latest</th>
                </tr>
              </thead>
              <tbody>
                {data.topUsers.map((u) => (
                  <tr key={u.userId} className="border-t border-line/60">
                    <td className="px-4 py-2">
                      <Link to={`/users/${encodeURIComponent(u.userId)}`} className="font-medium text-accent hover:underline">
                        {u.username}
                      </Link>
                      {u.email && <div className="max-w-[14rem] truncate text-xs text-ink-faint">{u.email}</div>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{u.downloads.toLocaleString()}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-ink-muted">{formatBytes(u.bytes)}</td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-right text-ink-muted sm:table-cell" title={formatFullDate(u.lastAt)}>
                      {formatWhen(u.lastAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-line bg-panel">
          <h2 className="px-4 pt-4 text-sm font-semibold">Latest downloads</h2>
          <DownloadList entries={data.recent} showUser />
        </section>
      </div>
      <p className="text-xs text-ink-faint">
        {data.since ? `Almanac’s record starts ${formatFullDate(data.since)}; Silo forgets downloads once they’re deleted, Almanac keeps them. ` : ''}
        {data.syncedAt ? `Checked ${formatWhen(data.syncedAt)}.` : 'Not checked yet: Almanac copies downloads from Silo every 10 minutes.'}
      </p>
    </div>
  );
}

const STATUS: Record<string, string> = {
  preparing: 'Preparing',
  ready: 'Ready to download',
  downloading: 'Downloading',
  completed: 'Downloaded',
  failed: 'Failed',
  revoked: 'Removed',
};

/** A list of downloads, used here and on each user's page. */
export function DownloadList({ entries, showUser }: { entries: DownloadEntry[]; showUser?: boolean }) {
  const { can } = useAuth();
  const showIp = can('viewIpAddresses');
  if (!entries.length) return <p className="px-4 py-8 text-center text-sm text-ink-faint">No downloads yet.</p>;
  return (
    <ul className="mt-2 max-h-[34rem] divide-y divide-line/60 overflow-auto">
      {entries.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
          <span className="w-36 shrink-0 text-ink-muted" title={formatFullDate(d.createdAt)}>
            {formatWhen(d.createdAt)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">
              <span className="font-medium">{d.title}</span>
              {d.episode && <span className="text-ink-muted"> · {d.episode}</span>}
            </span>
            <span className="block truncate text-xs text-ink-faint">
              {[
                showUser ? d.username : null,
                d.deviceName,
                d.quality === 'original' ? 'Original quality' : d.quality,
                showIp ? d.ip : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          <span className={`text-xs ${d.present ? 'text-ink-muted' : 'text-ink-faint'}`}>{d.present ? (STATUS[d.status] ?? d.status) : 'Deleted from device'}</span>
          <span className="w-16 whitespace-nowrap text-right tabular-nums text-ink-muted">{formatBytes(d.sizeBytes)}</span>
        </li>
      ))}
    </ul>
  );
}
