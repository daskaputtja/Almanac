import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { streamSSE } from 'hono/streaming';
import type { HistoryQuery, HistorySort } from '../shared/history.js';
import type { PlayMethod } from '../shared/activity.js';
import type { ActivityMonitor } from './activity/monitor.js';
import type { Config } from './config.js';
import type { HistoryStore } from './history/store.js';
import type { HistorySync } from './history/sync.js';

export interface AppServices {
  monitor: ActivityMonitor;
  history: HistoryStore;
  historySync: HistorySync;
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

export function createApp(config: Pick<Config, 'auth' | 'webRoot'>, { monitor, history, historySync }: AppServices) {
  const app = new Hono();

  // Health checks stay open so Docker can probe the container.
  app.get('/api/health', (c) => {
    const { fetchedAt, error } = monitor.current();
    return c.json({ status: error ? 'degraded' : 'ok', fetchedAt, error });
  });

  if (config.auth) {
    app.use('*', basicAuth({ ...config.auth, realm: 'Almanac' }));
  }

  app.get('/api/activity', (c) => c.json(monitor.current()));

  app.get('/api/activity/stream', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const send = (snapshot: ReturnType<ActivityMonitor['current']>) =>
        stream.writeSSE({ event: 'activity', id: String(id++), data: JSON.stringify(snapshot) });

      await send(monitor.current());
      const unsubscribe = monitor.subscribe((snapshot) => void send(snapshot).catch(() => {}));

      // Keep the connection alive through proxies that close idle streams.
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(25_000);
        if (!stream.aborted && !stream.closed) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe();
    }),
  );

  app.get('/api/history', (c) => c.json(history.query(parseHistoryQuery(c.req.query()))));
  app.get('/api/history/filters', (c) => c.json(history.filterOptions()));
  app.get('/api/history/status', (c) => c.json(historySync.status()));

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // The built dashboard. Unknown paths fall back to index.html for client-side routing.
  app.use('/*', serveStatic({ root: config.webRoot }));
  app.get('*', serveStatic({ root: config.webRoot, path: 'index.html' }));

  return app;
}
