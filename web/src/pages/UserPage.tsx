import { useEffect, useMemo, useState } from 'react';
import type { HistoryEntry, HistoryPage } from '../../../shared/history';
import type { StatsRankBy } from '../../../shared/stats';
import type { UserDetail } from '../../../shared/users';
import { useAuth } from '../auth/AuthGate';
import { Avatar, RoleBadges } from '../components/Avatar';
import { MethodBadge } from '../components/MethodBadge';
import { StreamCard } from '../components/StreamCard';
import {
  HeatmapCard,
  PERIODS,
  PeriodPicker,
  PlaysTimelineCard,
  RankPicker,
  SHORT_PLAY_SECONDS,
  StatTiles,
  useStats,
} from '../components/StatsSections';
import { NotesAndTags } from '../components/NotesAndTags';
import { DownloadList } from './DownloadsTab';
import { WhereSection } from '../components/WhereSection';
import { TopList } from '../components/TopList';
import { UserTags } from '../components/UserTags';
import { episodeCode, formatBytes, formatDuration, formatFullDate, formatWhen, livePosition, platformLabel } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { useActivity, useNow } from '../lib/useActivity';

export function UserPage({ userId }: { userId: string }) {
  const { search } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const period = PERIODS[params.get('period') ?? ''] ? params.get('period')! : '30d';
  const rankBy: StatsRankBy = params.get('rank') === 'watched' ? 'watched' : 'plays';

  const [user, setUser] = useState<UserDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [recent, setRecent] = useState<HistoryEntry[] | null>(null);
  const { data, view, loading } = useStats(period, userId, rankBy);
  const activity = useActivity();
  const { can } = useAuth();
  const canSeeIps = can('viewIpAddresses');
  const now = useNow();

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    const q = next.toString();
    navigate(`/users/${encodeURIComponent(userId)}${q ? `?${q}` : ''}`, { replace: true });
  };

  useEffect(() => {
    setUser(null);
    setNotFound(false);
    fetch(`/api/users/${encodeURIComponent(userId)}`)
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          return null;
        }
        return r.json() as Promise<UserDetail>;
      })
      .then((u) => u && setUser(u))
      .catch(() => setNotFound(true));
    const q = new URLSearchParams({ user: userId, pageSize: '10', minWatched: String(SHORT_PLAY_SECONDS) });
    fetch(`/api/history?${q}`)
      .then((r) => r.json() as Promise<HistoryPage>)
      .then((page) => setRecent(page.items))
      .catch(() => setRecent([]));
  }, [userId]);

  const watchingNow = activity.snapshot?.streams.filter((s) => s.user.id === userId) ?? [];

  if (notFound) {
    return (
      <div className="py-20 text-center">
        <p className="font-medium">No user with that ID</p>
        <Link to="/users" className="mt-2 inline-block text-sm text-accent hover:underline">
          Back to all users
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Link to="/users" className="text-sm text-ink-muted hover:text-ink">
        ← All users
      </Link>

      {user ? (
        <header className="flex flex-wrap items-center gap-4">
          <Avatar name={user.name} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{user.name}</h1>
              <RoleBadges role={user.role} isOwner={user.isOwner} enabled={user.enabled} inSilo={user.inSilo} />
              <UserTags userId={user.id} />
              <Link
                to={`/users/${encodeURIComponent(user.id)}/recap?year=${new Date().getFullYear()}`}
                className="ml-1 rounded-lg border border-accent-dim bg-accent/10 px-2.5 py-1 text-xs font-medium hover:bg-accent/20"
              >
                {new Date().getFullYear()} recap
              </Link>
            </div>
            {user.email && (
              <p className="mt-0.5 text-sm text-ink-muted">
                <a href={`mailto:${user.email}`} className="hover:text-ink hover:underline">
                  {user.email}
                </a>
              </p>
            )}
            <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-muted">
              {user.createdAt && <Fact label="Member since" value={new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} />}
              {user.firstPlayedAt && <Fact label="First play" value={new Date(user.firstPlayedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} />}
              <Fact label="Last play" value={user.lastPlayedAt ? formatWhen(user.lastPlayedAt) : 'Never'} />
              {user.lastActiveAt && <Fact label="Last active in Silo" value={formatWhen(user.lastActiveAt)} />}
              <Fact label="All-time plays" value={user.plays.toLocaleString()} />
            </dl>
          </div>
        </header>
      ) : (
        <div className="h-16" />
      )}

      {user && can('moderate') && <NotesAndTags userId={user.id} username={user.name} />}

      {watchingNow.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Watching now</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {watchingNow.map((s) => (
              <StreamCard
                key={s.id}
                stream={s}
                liveNetworks={activity.snapshot?.liveNetworks?.[s.user.id]}
                position={livePosition(s, activity.snapshot!.fetchedAt, activity.receivedAt, now)}
              />
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker value={period} onChange={(p) => setParam('period', p === '30d' ? null : p)} />
        <div className="sm:ml-auto">
          <RankPicker value={rankBy} onChange={(r) => setParam('rank', r === 'plays' ? null : r)} />
        </div>
      </div>

      {data && view && (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <StatTiles data={data} view={view} singleUser />
          <PlaysTimelineCard view={view} />
          <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
            <HeatmapCard view={view} title="When they press play" />
            <TopList title="Top shows" entries={data.top.shows} rankBy={rankBy} />
            <TopList title="Top movies" entries={data.top.movies} rankBy={rankBy} />
          </div>
        </div>
      )}

      <WhereSection period={period} userId={userId} title="Where they watch" />

      <section className="rounded-xl border border-line bg-panel">
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="text-sm font-semibold">Recent plays</h2>
          <Link to={`/history?user=${encodeURIComponent(userId)}`} className="text-sm text-accent hover:underline">
            See all in History
          </Link>
        </div>
        <ul className="mt-2 divide-y divide-line/60">
          {recent?.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
              <span className="w-36 shrink-0 text-ink-muted" title={formatFullDate(e.endedAt)}>
                {formatWhen(e.endedAt)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {e.media.seriesTitle ? (
                  <>
                    <span className="font-medium">{e.media.seriesTitle}</span>
                    <span className="text-ink-muted"> · {[episodeCode(e.media.seasonNumber, e.media.episodeNumber), e.media.title].filter(Boolean).join(' · ')}</span>
                  </>
                ) : (
                  <span className="font-medium">{e.media.title}</span>
                )}
              </span>
              <span className="text-ink-muted">{[e.client.name, platformLabel(e.client.platform)].filter(Boolean).join(' · ')}</span>
              <span className="text-xs">
                <MethodBadge method={e.playback.method} />
              </span>
              <span className="w-16 text-right tabular-nums">{formatDuration(e.watchedSeconds)}</span>
            </li>
          ))}
          {recent && recent.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-faint">No plays yet</li>}
        </ul>
      </section>

      {user && (
        <div className={`grid gap-5 ${canSeeIps ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
          <SimpleTable
            title="Players"
            headers={['Player', 'Platform', 'Plays', 'Last used']}
            rows={user.devices.map((d) => [d.player, platformLabel(d.platform) ?? '—', d.plays.toLocaleString(), formatWhen(d.lastPlayedAt)])}
          />
          {canSeeIps && (
            <SimpleTable
              title="IP addresses"
              headers={['Address', 'Plays', 'First seen', 'Last seen']}
              rows={user.addresses.map((a) => [a.ip, a.plays.toLocaleString(), formatWhen(a.firstSeenAt), formatWhen(a.lastSeenAt)])}
              note={user.addresses.length === 50 ? 'Showing the 50 most recent addresses.' : undefined}
            />
          )}
          <SimpleTable
            title="Profiles"
            headers={['Profile', 'Plays', 'Last used']}
            rows={user.profiles.map((p) => [p.name, p.plays.toLocaleString(), formatWhen(p.lastPlayedAt)])}
          />
        </div>
      )}

      {user && (
        <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
          <section className="overflow-hidden rounded-xl border border-line bg-panel">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
              <h2 className="text-sm font-semibold">Offline downloads</h2>
              <p className="text-xs text-ink-muted">
                {user.downloads.last30Days.toLocaleString()} in the last 30 days ({formatBytes(user.downloads.last30DaysBytes)}) ·{' '}
                {user.downloads.onDevices.toLocaleString()} on devices now · {user.downloads.total.toLocaleString()} ever ({formatBytes(user.downloads.totalBytes)})
              </p>
            </div>
            <DownloadList entries={user.downloads.recent} />
          </section>
          <SimpleTable
            title={`Signed-in devices (${user.registeredDevices.length})`}
            headers={['Device', 'Kind', 'Profiles', 'Last used']}
            rows={user.registeredDevices.map((d) => [d.name, platformLabel(d.platform) ?? '—', d.profiles.join(', ') || '—', d.lastUsedAt ? formatWhen(d.lastUsedAt) : 'Never'])}
            note="Every device signed in to this account in Silo, whether or not it has played anything."
          />
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function SimpleTable({ title, headers, rows, note }: { title: string; headers: string[]; rows: string[][]; note?: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <h2 className="px-4 pt-4 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-faint">None yet</p>
      ) : (
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-panel text-xs text-ink-faint">
              <tr>
                {headers.map((h, i) => (
                  <th key={h} className={`px-4 py-2 font-medium ${i > 0 && h === 'Plays' ? 'text-right' : ''}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-t border-line/60">
                  {row.map((cell, i) => (
                    <td key={i} className={`px-4 py-2 ${i === 0 ? 'text-ink' : 'text-ink-muted'} ${headers[i] === 'Plays' ? 'text-right tabular-nums' : ''}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className="px-4 pb-3 text-xs text-ink-faint">{note}</p>}
    </section>
  );
}
