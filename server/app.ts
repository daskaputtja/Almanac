import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import type { HistoryQuery, HistorySort } from '../shared/history.js';
import type { PlayMethod } from '../shared/activity.js';
import type { ActivityMonitor } from './activity/monitor.js';
import type { ActivitySnapshot } from '../shared/activity.js';
import { can } from '../shared/permissions.js';
import type { UserDetail } from '../shared/users.js';
import { type AuthEnv, createAuth } from './auth/routes.js';
import type { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import type { StatsQuery } from '../shared/stats.js';
import type { HistoryStore } from './history/store.js';
import type { HistorySync } from './history/sync.js';
import type { LibraryService } from './library/library.js';
import type { StatsService } from './stats/stats.js';
import type { UsersService } from './users/users.js';

export interface AppServices {
  auth: AuthService;
  monitor: ActivityMonitor;
  history: HistoryStore;
  historySync: HistorySync;
  stats: StatsService;
  users: UsersService;
  library: LibraryService;
}

const PLAY_METHODS: PlayMethod[] = ['direct', 'direct_stream', 'remux', 'transcode'];
const SORTS: HistorySort[] = ['ended', 'user', 'title', 'watched'];

/** Turn `/api/history?…` query parameters into a validated HistoryQuery. */
export function parseHistoryQuery(params: Record<string, string | undefined>): HistoryQuery {
  const text = (key: string) => params[key]?.trim() || undefined;
  const int = (key: string) => {
    const n = Number(params[key]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  };
  const date = (key: string) => {
    const value = text(key);
    return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
  };
  const method = text('method');
  const sort = text('sort');
  const completed = text('completed');

  return {
    search: text('search'),
    userId: text('user'),
    mediaType: text('type'),
    method: PLAY_METHODS.includes(method as PlayMethod) ? (method as PlayMethod) : undefined,
    platform: text('platform'),
    from: date('from'),
    to: date('to'),
    minWatchedSeconds: int('minWatched'),
    completed: completed === 'true' ? true : completed === 'false' ? false : undefined,
    sort: SORTS.includes(sort as HistorySort) ? (sort as HistorySort) : undefined,
    direction: text('direction') === 'asc' ? 'asc' : 'desc',
    page: int('page'),
    pageSize: int('pageSize'),
  };
}

/** Turn `/api/stats?…` query parameters into a validated StatsQuery. */
export function parseStatsQuery(params: Record<string, string | undefined>): StatsQuery {
  const history = parseHistoryQuery(params);
  const limit = Number(params.limit);
  return {
    from: history.from,
    to: history.to,
    userId: history.userId,
    minWatchedSeconds: history.minWatchedSeconds,
    rankBy: params.rankBy === 'watched' ? 'watched' : 'plays',
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : undefined,
  };
}

/** A copy of the activity snapshot without viewers' IP addresses. */
export function withoutIps(snapshot: ActivitySnapshot): ActivitySnapshot {
  return { ...snapshot, streams: snapshot.streams.map((s) => ({ ...s, client: { ...s.client, ip: null } })) };
}

function userWithoutIps(user: UserDetail): UserDetail {
  return { ...user, addresses: [] };
}

export function createApp(
  config: Pick<Config, 'webRoot' | 'trustProxy' | 'secureCookies'>,
  { auth, monitor, history, historySync, stats, users, library }: AppServices,
) {
  const app = new Hono<AuthEnv>();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React sets style attributes (progress bars, chart colours).
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Posters come from Silo's image storage, which can be any HTTPS host.
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Health checks stay open so Docker can probe the container.
  app.get('/api/health', (c) => {
    const { fetchedAt, error } = monitor.current();
    return c.json({ status: error ? 'degraded' : 'ok', fetchedAt, error });
  });

  // Sign-in. Everything under /api below this needs a signed-in session.
  const { routes: authRoutes, csrf, requireSession } = createAuth(auth, config);
  app.use('/api/*', csrf);
  app.route('/api/auth', authRoutes);
  app.use('/api/*', requireSession);

  // Mods don't see viewers' IP addresses; they're removed before anything is sent.
  const seesIps = (c: { get: (key: 'session') => AuthEnv['Variables']['session'] }) => can(c.get('session').user.role, 'viewIpAddresses');

  app.get('/api/activity', (c) => c.json(seesIps(c) ? monitor.current() : withoutIps(monitor.current())));

  app.get('/api/activity/stream', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const send = (snapshot: ReturnType<ActivityMonitor['current']>) =>
        stream.writeSSE({ event: 'activity', id: String(id++), data: JSON.stringify(snapshot) });

      const ips = seesIps(c);
      const view = (snapshot: ActivitySnapshot) => (ips ? snapshot : withoutIps(snapshot));
      await send(view(monitor.current()));
      const unsubscribe = monitor.subscribe((snapshot) => void send(view(snapshot)).catch(() => {}));

      // Keep the connection alive through proxies that close idle streams.
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(25_000);
        if (!stream.aborted && !stream.closed) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe();
    }),
  );

  app.get('/api/history', (c) => c.json(history.query(parseHistoryQuery(c.req.query()), { includeIp: seesIps(c) })));
  app.get('/api/history/filters', (c) => c.json(history.filterOptions()));
  app.get('/api/history/status', (c) => c.json(historySync.status()));
  app.get('/api/stats', (c) => c.json(stats.get(parseStatsQuery(c.req.query()))));

  app.get('/api/users', (c) => c.json({ users: users.list() }));
  app.get('/api/users/:id', (c) => {
    const user = users.get(c.req.param('id'));
    if (!user) return c.json({ error: 'No such user' }, 404);
    return c.json(seesIps(c) ? user : userWithoutIps(user));
  });

  app.get('/api/libraries', (c) => c.json(library.libraries()));
  app.get('/api/libraries/recent', (c) => {
    const q = c.req.query();
    const days = Number(q.days);
    const limit = Number(q.limit);
    return c.json({
      items: library.recent({
        libraryId: q.library || undefined,
        kind: q.kind === 'movie' || q.kind === 'show' ? q.kind : undefined,
        days: Number.isFinite(days) && days > 0 ? days : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // The built dashboard. Unknown paths fall back to index.html for client-side routing.
  app.use('/*', serveStatic({ root: config.webRoot }));
  app.get('*', serveStatic({ root: config.webRoot, path: 'index.html' }));

  return app;
}
