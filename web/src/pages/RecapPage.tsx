import { useEffect, useMemo, useState } from 'react';
import type { Recap, RecapTitle } from '../../../shared/recap';
import { StackedBars } from '../components/charts/StackedBars';
import { WeekHourHeatmap } from '../components/charts/WeekHourHeatmap';
import { ApiError, api } from '../lib/api';
import { platformLabel } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { buildWeekHourGrid, hourStart } from '../lib/statsData';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A year in review for one user (`userId`) or the whole server. */
export function RecapPage({ userId }: { userId?: string }) {
  const { search } = useLocation();
  const year = Number(new URLSearchParams(search).get('year')) || new Date().getFullYear();
  const [recap, setRecap] = useState<Recap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecap(null);
    setError(null);
    const q = new URLSearchParams({ year: String(year) });
    if (userId) q.set('user', userId);
    api<Recap>(`/api/recap?${q}`)
      .then(setRecap)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Couldn’t load the recap.'));
  }, [year, userId]);

  const local = useMemo(() => (recap ? localFacts(recap) : null), [recap]);
  const base = userId ? `/users/${encodeURIComponent(userId)}/recap` : '/recap';

  if (error) return <p className="py-20 text-center text-sm text-red-300">{error}</p>;
  if (!recap || !local) return <p className="py-20 text-center text-sm text-ink-muted">Gathering the year…</p>;

  const who = recap.user ? `${recap.user.name}’s` : 'The server’s';
  const hours = recap.totals.watchedSeconds / 3600;
  const empty = recap.totals.plays === 0;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {recap.user ? (
          <Link to={`/users/${encodeURIComponent(recap.user.id)}`} className="text-sm text-ink-muted hover:text-ink">
            ← {recap.user.name}
          </Link>
        ) : (
          <Link to="/stats" className="text-sm text-ink-muted hover:text-ink">
            ← Statistics
          </Link>
        )}
        {recap.availableYears.length > 1 && (
          <div className="flex rounded-lg border border-line bg-panel p-0.5" role="group" aria-label="Year">
            {recap.availableYears.map((y) => (
              <button
                key={y}
                type="button"
                aria-pressed={y === year}
                onClick={() => navigate(`${base}?year=${y}`, { replace: true })}
                className={`rounded-md px-3 py-1 text-sm ${y === year ? 'bg-panel-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-harvest-dim/50 bg-gradient-to-br from-harvest/20 via-panel to-panel p-6 sm:p-10">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-harvest">{year} in review</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-5xl">{who} year</h1>
        {empty ? (
          <p className="mt-6 text-lg text-ink-muted">Nothing was played in {year}.</p>
        ) : (
          <>
            <p className="mt-6 text-6xl font-bold tabular-nums tracking-tight sm:text-8xl">{Math.round(hours).toLocaleString()}</p>
            <p className="mt-1 text-xl text-ink-muted">
              hours watched{hours >= 48 && <>, or {(hours / 24).toFixed(hours >= 240 ? 0 : 1)} days</>}
            </p>
            {recap.percentile != null && recap.percentile >= 50 && (
              <p className="mt-4 inline-block rounded-full bg-canvas/60 px-4 py-1.5 text-sm">
                More than <strong className="text-harvest">{recap.percentile}%</strong> of viewers this year
              </p>
            )}
          </>
        )}
        {recap.coverage.partial && recap.coverage.from && (
          <p className="mt-6 text-xs text-ink-faint">
            Almanac’s history starts on {new Date(recap.coverage.from).toLocaleDateString(undefined, { dateStyle: 'long' })}, so this covers
            the year from then.
          </p>
        )}
      </section>

      {!empty && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Big value={recap.totals.plays.toLocaleString()} label="plays" />
            <Big value={recap.totals.movies.toLocaleString()} label={recap.totals.movies === 1 ? 'movie' : 'movies'} />
            <Big value={recap.totals.episodes.toLocaleString()} label={`episodes of ${recap.totals.shows.toLocaleString()} shows`} />
            <Big value={local.activeDays.toLocaleString()} label={local.activeDays === 1 ? 'day with something on' : 'days with something on'} />
          </div>

          {recap.server && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Big value={recap.server.activeUsers.toLocaleString()} label="people watched something" />
              <Big value={recap.server.newMovies.toLocaleString()} label="movies added" />
              <Big value={recap.server.newShows.toLocaleString()} label="shows added" />
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-2">
            <TopTitles title="Top shows" titles={recap.topShows} />
            <TopTitles title="Top movies" titles={recap.topMovies} />
          </div>

          <section className="rounded-2xl border border-line bg-panel p-5">
            <h2 className="mb-3 font-semibold">Hours watched each month</h2>
            <StackedBars
              series={[{ key: 'hours', label: 'Hours watched', color: 'var(--color-harvest)' }]}
              bars={local.months.map((m) => ({ id: m.label, label: m.short, title: m.label, values: { hours: Math.round(m.hours) } }))}
              label="Hours watched each month"
              height={220}
            />
          </section>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recap.topGenres[0] && (
              <Fact label="Favourite genre" value={recap.topGenres[0].genre} detail={recap.topGenres.slice(1).map((g) => g.genre).join(' and then ') || undefined} />
            )}
            {recap.biggestBinge && (
              <Fact
                label="Biggest binge"
                value={`${recap.biggestBinge.episodes} episodes of ${recap.biggestBinge.title}`}
                detail={`in one day, ${new Date(`${recap.biggestBinge.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}${recap.biggestBinge.userName ? `, by ${recap.biggestBinge.userName}` : ''}`}
              />
            )}
            {recap.longestSitting && recap.longestSitting.seconds >= 3600 && (
              <Fact
                label="Longest sitting"
                value={`${(recap.longestSitting.seconds / 3600).toFixed(1)} hours`}
                detail={`${recap.longestSitting.titles} titles in a row, starting ${new Date(recap.longestSitting.start).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`}
              />
            )}
            {local.longestStreak > 1 && (
              <Fact label="Longest streak" value={`${local.longestStreak} days in a row`} detail={local.streakRange} />
            )}
            {local.busiestDay && <Fact label="Busiest day" value={local.busiestDay.label} detail={`${local.busiestDay.hours.toFixed(1)} hours watched`} />}
            <Fact label="Favourite time" value={`${local.favouriteDay}s`} detail={`most often around ${local.favouriteHour}`} />
            {recap.favouritePlayer && (
              <Fact
                label="Watched most on"
                value={recap.favouritePlayer.name}
                detail={recap.favouritePlatform ? `${platformLabel(recap.favouritePlatform.name)} · ${Math.round((recap.favouritePlayer.plays / recap.totals.plays) * 100)}% of plays` : undefined}
              />
            )}
            {recap.firstPlay && (
              <Fact
                label="First play of the year"
                value={recap.firstPlay.title}
                detail={new Date(recap.firstPlay.at).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}
              />
            )}
            {recap.directPlayPercent != null && (
              <Fact label="Direct play" value={`${Math.round(recap.directPlayPercent)}%`} detail="of plays needed no conversion" />
            )}
          </div>

          <section className="rounded-2xl border border-line bg-panel p-5">
            <h2 className="mb-3 font-semibold">When {recap.user ? 'they' : 'people'} pressed play</h2>
            <WeekHourHeatmap grid={local.grid} label="Plays by day of the week and hour" />
            <p className="mt-2 text-[11px] text-ink-faint">Times are in your time zone.</p>
          </section>

          {recap.server && recap.server.topUsers.length > 0 && (
            <section className="rounded-2xl border border-line bg-panel p-5">
              <h2 className="mb-3 font-semibold">Biggest viewers</h2>
              <ol className="space-y-2">
                {recap.server.topUsers.map((u, i) => (
                  <li key={u.id} className="flex items-baseline gap-3">
                    <span className="w-5 text-right text-sm tabular-nums text-ink-faint">{i + 1}</span>
                    <Link to={`/users/${encodeURIComponent(u.id)}/recap?year=${year}`} className="font-medium text-harvest hover:underline">
                      {u.name}
                    </Link>
                    <span className="ml-auto tabular-nums">{Math.round(u.watchedSeconds / 3600).toLocaleString()} hours</span>
                    <span className="w-24 text-right text-sm tabular-nums text-ink-faint">{u.plays.toLocaleString()} plays</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Big({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-5">
      <p className="text-3xl font-bold tabular-nums tracking-tight sm:text-4xl">{value}</p>
      <p className="mt-1 text-sm text-ink-muted">{label}</p>
    </div>
  );
}

function Fact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-harvest">{label}</p>
      <p className="mt-2 text-lg font-semibold leading-snug">{value}</p>
      {detail && <p className="mt-1 text-sm text-ink-muted">{detail}</p>}
    </div>
  );
}

function TopTitles({ title, titles }: { title: string; titles: RecapTitle[] }) {
  if (!titles.length) return null;
  const [first, ...rest] = titles;
  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      <h2 className="mb-4 font-semibold">{title}</h2>
      <div className="flex gap-4">
        <Poster url={first!.posterUrl} title={first!.title} large />
        <div className="min-w-0 self-end">
          <p className="text-xs font-semibold uppercase tracking-wider text-harvest">Number 1</p>
          <p className="mt-1 text-xl font-bold leading-tight">{first!.title}</p>
          <p className="mt-1 text-sm text-ink-muted">
            {hoursText(first!.watchedSeconds)}
            {first!.detail && ` · ${first!.detail}`}
          </p>
        </div>
      </div>
      <ol start={2} className="mt-4 space-y-2.5">
        {rest.map((t, i) => (
          <li key={t.key} className="flex items-center gap-3">
            <span className="w-4 text-right text-sm tabular-nums text-ink-faint">{i + 2}</span>
            <Poster url={t.posterUrl} title={t.title} />
            <div className="min-w-0">
              <p className="truncate font-medium">{t.title}</p>
              <p className="text-xs text-ink-muted">
                {hoursText(t.watchedSeconds)}
                {t.detail && ` · ${t.detail}`}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Poster({ url, title, large }: { url: string | null; title: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const size = large ? 'h-36 w-24' : 'h-12 w-8';
  if (!url || failed) {
    return (
      <div className={`${size} flex shrink-0 items-center justify-center rounded-md bg-panel-raised p-1 text-center text-[9px] leading-tight text-ink-faint`}>
        {large ? title : ''}
      </div>
    );
  }
  return <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`${size} shrink-0 rounded-md object-cover`} />;
}

function hoursText(seconds: number): string {
  const h = seconds / 3600;
  return h >= 10 ? `${Math.round(h).toLocaleString()} hours` : h >= 1 ? `${h.toFixed(1)} hours` : `${Math.round(seconds / 60)} minutes`;
}

/** Facts that depend on the viewer's time zone, worked out from UTC hours. */
function localFacts(recap: Recap) {
  const dayTotals = new Map<string, number>();
  const monthHours = Array<number>(12).fill(0);
  for (const [hour, , watched] of recap.hours) {
    const d = hourStart(hour);
    if (d.getFullYear() === recap.year) monthHours[d.getMonth()]! += watched / 3600;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    dayTotals.set(key, (dayTotals.get(key) ?? 0) + watched);
  }

  // Longest run of consecutive days with something played.
  const days = [...dayTotals.keys()]
    .map((k) => {
      const [y, m, d] = k.split('-').map(Number);
      return new Date(y!, m!, d!).getTime();
    })
    .sort((a, b) => a - b);
  let longestStreak = 0;
  let streakStart = 0;
  let bestStart = 0;
  let bestEnd = 0;
  for (let i = 0; i < days.length; i++) {
    const continues = i > 0 && Math.round((days[i]! - days[i - 1]!) / 86_400_000) === 1;
    if (!continues) streakStart = days[i]!;
    const length = Math.round((days[i]! - streakStart) / 86_400_000) + 1;
    if (length > longestStreak) {
      longestStreak = length;
      bestStart = streakStart;
      bestEnd = days[i]!;
    }
  }
  const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  let busiest: { key: string; seconds: number } | null = null;
  for (const [key, seconds] of dayTotals) if (!busiest || seconds > busiest.seconds) busiest = { key, seconds };
  const busiestDay = busiest
    ? (() => {
        const [y, m, d] = busiest.key.split('-').map(Number);
        return {
          label: new Date(y!, m!, d!).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
          hours: busiest.seconds / 3600,
        };
      })()
    : null;

  const grid = buildWeekHourGrid(recap.hours);
  const byDay = grid.map((row) => row.reduce((a, b) => a + b, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((sum, row) => sum + row[h]!, 0));
  const favouriteDay = DAY_NAMES[byDay.indexOf(Math.max(...byDay))]!;
  const topHour = byHour.indexOf(Math.max(...byHour));

  return {
    activeDays: dayTotals.size,
    longestStreak,
    streakRange: longestStreak > 1 ? `${fmt(bestStart)} to ${fmt(bestEnd)}` : '',
    busiestDay,
    favouriteDay,
    favouriteHour: new Date(2000, 0, 1, topHour).toLocaleTimeString(undefined, { hour: 'numeric' }),
    grid,
    months: monthHours.map((hours, i) => ({
      hours,
      short: new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'short' }),
      label: new Date(recap.year, i, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    })),
  };
}
