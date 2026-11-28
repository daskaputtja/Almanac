import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import type { HistoryQuery, HistorySort } from '../shared/history.js';
import type { PlayMethod } from '../shared/activity.js';
import type { ActivityMonitor } from './activity/monitor.js';
import type { ActivitySnapshot } from '../shared/activity.js';
import { can } from '../shared/permissions.js';
import { validateThresholds } from '../shared/moderation.js';
import type { UserDetail } from '../shared/users.js';
import { type AuthEnv, createAuth, requirePermission } from './auth/routes.js';
import type { AuthService } from './auth/service.js';
import type { Config } from './config.js';
import type { StatsQuery } from '../shared/stats.js';
import type { HistoryStore } from './history/store.js';
import type { HistorySync } from './history/sync.js';
import type { LibraryService } from './library/library.js';
import { type Actor, ModerationError, type ModerationService } from './moderation/service.js';
import type { ServerOverviewService } from './server/overview.js';
import type { LoadHistory } from './load/load.js';
import type { TranscodeDoctor } from './transcodes/doctor.js';
import type { TrendingService } from './trending/trending.js';
import { LOAD_RANGES, type LoadRange } from '../shared/load.js';
import { RecapError, type RecapService } from './recap/recap.js';
import { ShareError, type RecapShares } from './recap/shares.js';
import type { GeoService } from './geo/geo.js';
import type { AccountsService } from './accounts/accounts.js';
import type { ReliabilityService } from './reliability/reliability.js';
import { CapacityError, type CapacityService } from './capacity/capacity.js';
import type { PlaybackHealth } from './health/health.js';
import { PortalApiError, type PortalApi } from './portal/portal.js';
import type { AutoRequests } from './suspensions/auto.js';
import type { ArtworkService } from './library/artwork.js';
import type { TelegramService } from './notify/telegram.js';
import { FailureLimiter } from './auth/rateLimit.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { PORTAL_API_VERSION } from '../shared/portal.js';
import type { StaffAlerts } from './notify/staff.js';
import type { LibraryBoard } from './notify/board.js';
import type { StatusBoard } from './notify/status.js';
import { PushError, type PushService } from './push/push.js';
import { APP_API_VERSION, type AppServerInfo } from '../shared/app.js';
import { SuspensionError, type SuspensionActor, type SuspensionService } from './suspensions/suspensions.js';
import type { SuspensionStatus } from '../shared/suspensions.js';
import { RELIABILITY_RANGES, type ReliabilityRange } from '../shared/reliability.js';
import { MetadataError, type MetadataService } from './notify/metadata.js';
import { NotifyError, type Notifier } from './notify/notifier.js';
import type { NotifyChannelInput } from '../shared/notifications.js';
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
  moderation: ModerationService;
  overview: ServerOverviewService;
  recap: RecapService;
  load: LoadHistory;
  transcodes: TranscodeDoctor;
  trending: TrendingService;
  shares: RecapShares;
  geo: GeoService;
  notifier: Notifier;
  metadata: MetadataService;
  accounts: AccountsService;
  reliability: ReliabilityService;
  capacity: CapacityService;
  health: PlaybackHealth;
  portalApi: PortalApi;
  autoRequests: AutoRequests;
  artwork: ArtworkService;
  telegram: TelegramService;
  staff: StaffAlerts;
  suspensions: SuspensionService;
  board: LibraryBoard;
  statusBoard: StatusBoard;
  push: PushService;
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
  // Mods can know a stream is on a VPN, but not the address or who runs it.
  return {
    ...snapshot,
    streams: snapshot.streams.map((s) => ({ ...s, client: { ...s.client, ip: null, network: s.client.network ? { operator: null, vpn: s.client.network.vpn } : null } })),
  };
}

function userWithoutIps(user: UserDetail): UserDetail {
  return { ...user, addresses: [] };
}

export function createApp(
  config: Pick<Config, 'webRoot' | 'trustProxy' | 'secureCookies'> & { siloUrl?: string },
  { auth, monitor, history, historySync, stats, users, library, moderation, overview, recap, load, transcodes, trending, shares, geo, notifier, metadata, accounts, reliability, capacity, health, portalApi, autoRequests, artwork, telegram, staff, suspensions, board, statusBoard, push }: AppServices,
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

  // The phone app checks an address is an Almanac before asking anyone to sign in.
  app.get('/api/app/info', (c) => {
    let siloHost: string | null = null;
    try {
      siloHost = config.siloUrl ? new URL(config.siloUrl).host : null;
    } catch {
      siloHost = null;
    }
    const info: AppServerInfo = { app: 'almanac', apiVersion: APP_API_VERSION, siloHost };
    return c.json(info);
  });

  // Silo's artwork, passed on from Almanac's own address, so browsers (and Discord) never
  // need to reach Silo directly. Only Silo's poster and artwork paths: these are public,
  // signed links in Silo too, so no sign-in is needed (shared recaps show posters).
  app.get('/api/artwork/*', async (c) => {
    const result = await artwork.get(c.req.path.slice('/api/artwork/'.length), new URL(c.req.url).search, c.req.header('if-none-match'));
    if (result.status === 304) return c.body(null, 304, { ETag: result.etag! });
    if (result.status !== 200) {
      if (result.retryAfter) c.header('Retry-After', String(result.retryAfter));
      return c.body(null, result.status);
    }
    return new Response(new Uint8Array(result.body!), {
      status: 200,
      headers: { 'Content-Type': result.type!, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', ...(result.etag ? { ETag: result.etag } : {}) },
    });
  });

  // A shared recap link works without signing in, and shows only that recap.
  app.get('/api/public/recap/:token', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    const recap = shares.open(c.req.param('token'));
    return recap ? c.json(recap) : c.json({ error: 'This link doesn’t work any more. Ask for a new one.' }, 404);
  });

  // ----- The billing portal's API: its own key, no session, never any IP addresses -----
  const portalFailures = new FailureLimiter(20, 15 * 60_000);
  const clientAddress = (c: Context): string => {
    if (config.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown'; // not running under the Node server (tests)
    }
  };
  app.use('/api/portal/v1/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const who = clientAddress(c);
    const wait = portalFailures.retryAfter(who);
    if (wait) {
      c.header('Retry-After', String(wait));
      return c.json({ error: 'Too many requests with a wrong key. Try again later.' }, 429);
    }
    const token = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!portalApi.verify(token)) {
      portalFailures.fail(who);
      return c.json({ error: 'Send the portal API key from Almanac’s Settings as “Authorization: Bearer <key>”.' }, 401);
    }
    await next();
  });
  app.get('/api/portal/v1', (c) => c.json({ app: 'almanac', apiVersion: PORTAL_API_VERSION }));
  app.get('/api/portal/v1/customers', (c) => {
    const id = portalApi.find({ id: c.req.query('id'), username: c.req.query('username'), email: c.req.query('email') });
    const customer = id ? portalApi.customer(id) : null;
    return customer ? c.json({ customer }) : c.json({ error: 'No customer with that id, username or email in Silo.' }, 404);
  });
  app.get('/api/portal/v1/customers/:id', (c) => {
    const customer = portalApi.customer(c.req.param('id'));
    return customer ? c.json({ customer }) : c.json({ error: 'No customer with that id in Silo.' }, 404);
  });
  const days = (value: string | undefined) => (value === undefined ? 30 : Number(value));
  app.get('/api/portal/v1/customers/:id/usage', (c) => {
    const id = portalApi.find({ id: c.req.param('id') });
    if (!id) return c.json({ error: 'No customer with that id in Silo.' }, 404);
    return c.json({ id, usage: portalApi.usage(id, days(c.req.query('days'))) });
  });
  app.get('/api/portal/v1/usage', (c) => c.json({ customers: portalApi.allUsage(days(c.req.query('days'))) }));
  app.post('/api/portal/v1/events', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json({ ok: true, ...portalApi.recordEvent(body) }, 201);
  });

  // Sign-in. Everything under /api below this needs a signed-in session.
  const { routes: authRoutes, csrf, requireSession } = createAuth(auth, config);
  app.use('/api/*', csrf);
  app.route('/api/auth', authRoutes);
  app.use('/api/*', requireSession);

  // Mods don't see viewers' IP addresses; they're removed before anything is sent.
  const seesIps = (c: { get: (key: 'session') => AuthEnv['Variables']['session'] }) => can(c.get('session').user.role, 'viewIpAddresses');

  /** Add who operates each stream's network. */
  const withNetworks = (snapshot: ActivitySnapshot): ActivitySnapshot => ({
    ...snapshot,
    streams: snapshot.streams.map((s) => ({ ...s, client: { ...s.client, network: geo.networkFor(s.client.ip) } })),
  });
  app.get('/api/activity', (c) => c.json(seesIps(c) ? withNetworks(monitor.current()) : withoutIps(withNetworks(monitor.current()))));

  app.get('/api/activity/stream', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const send = (snapshot: ReturnType<ActivityMonitor['current']>) =>
        stream.writeSSE({ event: 'activity', id: String(id++), data: JSON.stringify(snapshot) });

      const ips = seesIps(c);
      const view = (snapshot: ActivitySnapshot) => (ips ? withNetworks(snapshot) : withoutIps(withNetworks(snapshot)));
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

  app.get('/api/server/overview', (c) => c.json(overview.overview()));
  app.get('/api/server/load', (c) => {
    const range = c.req.query('range');
    const key = (LOAD_RANGES.find((r) => r.key === range)?.key ?? '24h') as LoadRange['key'];
    return c.json(load.load(key));
  });
  app.get('/api/server/transcodes', (c) => {
    const days = Number(c.req.query('days'));
    return c.json(transcodes.report([7, 30, 90].includes(days) ? days : 30));
  });
  app.get('/api/server/nodes', (c) => {
    const streamsByNode = new Map<string, number>();
    for (const s of monitor.current().streams) {
      if (s.egressNode) streamsByNode.set(s.egressNode, (streamsByNode.get(s.egressNode) ?? 0) + 1);
    }
    return c.json(overview.nodeList(streamsByNode));
  });

  app.get('/api/recap/shares', requirePermission('shareRecaps'), (c) => c.json({ shares: shares.list(c.req.query('user') ?? '') }));
  app.post('/api/recap/shares', requirePermission('shareRecaps'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { user?: unknown; year?: unknown };
    const year = Number(body.year);
    if (typeof body.user !== 'string' || !Number.isInteger(year)) return c.json({ error: 'Choose a user and a year.' }, 400);
    try {
      return c.json(shares.create(body.user, year, c.get('session').user.username), 201);
    } catch (err) {
      if (err instanceof RecapError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });
  app.post('/api/recap/shares/:id/revoke', requirePermission('shareRecaps'), (c) => {
    try {
      shares.revoke(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ShareError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  app.get('/api/recap', (c) => {
    const year = Number(c.req.query('year') ?? new Date().getUTCFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return c.json({ error: 'Choose a year.' }, 400);
    try {
      return c.json(recap.get(year, c.req.query('user') || null));
    } catch (err) {
      if (err instanceof RecapError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  app.get('/api/history', (c) => {
    const page = history.query(parseHistoryQuery(c.req.query()), { includeIp: seesIps(c) });
    // Admins see who runs each address; nobody else gets addresses at all.
    if (seesIps(c)) for (const e of page.items) e.client.network = geo.networkFor(e.client.ip);
    return c.json(page);
  });
  app.get('/api/history/filters', (c) => c.json(history.filterOptions()));
  app.get('/api/history/status', (c) => c.json(historySync.status()));
  app.get('/api/stats', (c) => c.json(stats.get(parseStatsQuery(c.req.query()))));
  // Countries for everyone; cities (close to exact locations) for admins only.
  app.get('/api/stats/map', (c) => {
    const q = parseStatsQuery(c.req.query());
    return c.json(geo.map({ from: q.from, userId: q.userId, minWatchedSeconds: q.minWatchedSeconds }, seesIps(c)));
  });

  app.get('/api/users', (c) => c.json({ users: users.list() }));
  app.get('/api/users/:id', (c) => {
    const found = users.get(c.req.param('id'));
    if (!found) return c.json({ error: 'No such user' }, 404);
    const user = { ...found, downloads: accounts.forUser(found.id, seesIps(c)), registeredDevices: accounts.devicesForUser(found.id), health: health.forUser(found.id) };
    if (seesIps(c)) for (const a of user.addresses) a.network = geo.networkFor(a.ip);
    return c.json(seesIps(c) ? user : userWithoutIps(user));
  });
  app.get('/api/downloads', (c) => c.json(accounts.overview(seesIps(c))));
  app.get('/api/server/capacity', (c) => c.json(capacity.report()));
  app.post('/api/server/capacity', requirePermission('configureCapacity'), async (c) => {
    const body = await jsonBody(c);
    try {
      return c.json(capacity.setLimits(body, c.get('session').user.username));
    } catch (err) {
      if (err instanceof CapacityError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.get('/api/server/health', (c) => c.json(health.overview()));
  app.get('/api/server/reliability', async (c) => {
    const range = c.req.query('range') ?? '7d';
    return c.json(await reliability.report((range in RELIABILITY_RANGES ? range : '7d') as ReliabilityRange));
  });

  app.get('/api/libraries', (c) => c.json(library.libraries()));
  app.get('/api/trending', (c) => c.json(trending.get()));
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

  // ----- Moderation: flags, notes and tags (admins and mods) -----
  app.use('/api/moderation/*', requirePermission('moderate'));
  app.onError((err, c) => {
    if (err instanceof ModerationError) return c.json({ error: err.message }, err.status);
    if (err instanceof NotifyError || err instanceof MetadataError) return c.json({ error: err.message }, 400);
    if (err instanceof SuspensionError) return c.json({ error: err.message }, err.status);
    if (err instanceof PushError) return c.json({ error: err.message }, 400);
    if (err instanceof PortalApiError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Something went wrong.' }, 500);
  });
  const actor = (c: { get: (key: 'session') => AuthEnv['Variables']['session'] }): Actor => {
    const { user } = c.get('session');
    return { id: user.id, name: user.username, manageAllNotes: can(user.role, 'manageAllNotes') };
  };
  const jsonBody = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    try {
      const body = await c.req.json();
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const text = (v: unknown) => (typeof v === 'string' ? v : '');

  app.get('/api/moderation/flags', (c) => {
    const status = c.req.query('status');
    const result = moderation.flags({
      status: status === 'reviewed' || status === 'all' ? status : status === 'open' ? 'open' : 'all',
      userId: c.req.query('user') || undefined,
      includeAdminDetails: seesIps(c),
    });
    return c.json({ ...result, counts: { ...result.counts, pendingSuspensions: suspensions.pendingCount() } });
  });
  app.post('/api/moderation/flags/:id/review', async (c) => {
    moderation.review(c.req.param('id'), actor(c), text((await jsonBody(c)).note));
    return c.json({ ok: true });
  });
  app.post('/api/moderation/flags/:id/reopen', (c) => {
    moderation.reopen(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/moderation/exceptions', (c) => c.json({ exceptions: moderation.exceptions() }));
  app.post('/api/moderation/users/:id/exceptions', async (c) => {
    const body = await jsonBody(c);
    return c.json(moderation.addException(c.req.param('id'), actor(c), { group: body.group, upTo: body.upTo, reason: body.reason, days: body.days }), 201);
  });
  app.post('/api/moderation/users/:id/exceptions/:group/remove', (c) => {
    moderation.removeException(c.req.param('id'), c.req.param('group'), actor(c));
    return c.json({ ok: true });
  });
  app.get('/api/moderation/users/:id/case', (c) => {
    const file = moderation.caseFile(c.req.param('id'), suspensions, { actor: actor(c), includeAdminDetails: seesIps(c) });
    return file ? c.json(file) : c.json({ error: 'No such user.' }, 404);
  });

  app.get('/api/moderation/users/:id/notes', (c) => c.json({ notes: moderation.notes(c.req.param('id'), actor(c)) }));
  app.post('/api/moderation/users/:id/notes', async (c) => {
    moderation.addNote(c.req.param('id'), actor(c), text((await jsonBody(c)).body));
    return c.json({ ok: true }, 201);
  });
  app.post('/api/moderation/notes/:id', async (c) => {
    moderation.editNote(Number(c.req.param('id')), actor(c), text((await jsonBody(c)).body));
    return c.json({ ok: true });
  });
  app.post('/api/moderation/notes/:id/delete', (c) => {
    moderation.deleteNote(Number(c.req.param('id')), actor(c));
    return c.json({ ok: true });
  });

  app.get('/api/moderation/thresholds', (c) => c.json(moderation.thresholdsResponse()));
  app.post('/api/moderation/thresholds/preview', requirePermission('configureFlags'), async (c) => {
    const thresholds = validateThresholds((await jsonBody(c)).thresholds);
    if (typeof thresholds === 'string') return c.json({ error: thresholds }, 400);
    return c.json(moderation.preview(thresholds));
  });
  app.post('/api/moderation/thresholds', requirePermission('configureFlags'), async (c) => {
    const thresholds = validateThresholds((await jsonBody(c)).thresholds);
    if (typeof thresholds === 'string') return c.json({ error: thresholds }, 400);
    moderation.setThresholds(thresholds, c.get('session').user.username);
    return c.json(moderation.thresholdsResponse());
  });

  app.get('/api/moderation/tags', (c) => c.json(moderation.tags()));
  app.post('/api/moderation/users/:id/tags', async (c) => {
    const tags = (await jsonBody(c)).tags;
    return c.json({ tags: moderation.setTags(c.req.param('id'), actor(c), Array.isArray(tags) ? tags : []) });
  });

  // Discord notifications: admins only. Webhook addresses and API keys never leave the server.
  const notifications = requirePermission('manageNotifications');
  const channelInput = (body: Record<string, unknown>): NotifyChannelInput => ({
    name: typeof body.name === 'string' ? body.name : undefined,
    webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined,
    libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : undefined,
    quality: typeof body.quality === 'string' ? (body.quality as NotifyChannelInput['quality']) : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  });
  const optionalText = (value: unknown) => (value === undefined ? undefined : typeof value === 'string' ? value : null);
  app.get('/api/notifications', notifications, (c) => c.json({ ...notifier.overview(), staff: staff.view(), board: board.view(), status: statusBoard.view() }));
  app.post('/api/notifications/status', notifications, async (c) => {
    const body = await jsonBody(c);
    const text = (value: unknown) => (value === null ? null : typeof value === 'string' ? value : undefined);
    return c.json(
      await statusBoard.configure(
        {
          pageUrl: text(body.pageUrl),
          webhookUrl: text(body.webhookUrl),
          accessClientId: text(body.accessClientId),
          accessClientSecret: text(body.accessClientSecret),
        },
        c.get('session').user.username,
      ),
    );
  });
  app.post('/api/notifications/status/refresh', notifications, async (c) => {
    await statusBoard.update(true);
    return c.json(statusBoard.view());
  });
  app.post('/api/notifications/board', notifications, async (c) => {
    const body = await jsonBody(c);
    return c.json(
      await board.configure(
        {
          webhookUrl: body.webhookUrl === null ? null : typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined,
          hiddenLibraryIds: Array.isArray(body.hiddenLibraryIds) ? body.hiddenLibraryIds.map(String) : undefined,
        },
        c.get('session').user.username,
      ),
    );
  });
  app.post('/api/notifications/board/refresh', notifications, async (c) => {
    await board.update();
    return c.json(board.view());
  });
  app.get('/api/notifications/telegram', notifications, (c) => c.json(telegram.view()));
  app.post('/api/notifications/telegram', notifications, async (c) => {
    const body = await jsonBody(c);
    const token = body.token === null ? null : typeof body.token === 'string' ? body.token : undefined;
    if (token === undefined) return c.json({ error: 'Send the bot token.' }, 400);
    return c.json(await telegram.setToken(token, c.get('session').user.username));
  });
  app.post('/api/notifications/telegram/chats', notifications, async (c) => c.json(await telegram.findChats()));
  app.post('/api/notifications/telegram/target', notifications, async (c) => {
    const body = await jsonBody(c);
    if (body.board !== 'library' && body.board !== 'status') return c.json({ error: 'Choose a board.' }, 400);
    const chatId = typeof body.chatId === 'string' && body.chatId ? body.chatId : null;
    const topic = body.topic === null || body.topic === '' ? null : typeof body.topic === 'string' ? body.topic : undefined;
    return c.json(await telegram.setTarget(body.board, chatId, c.get('session').user.username, topic));
  });
  app.post('/api/notifications/staff', notifications, async (c) => {
    const body = await jsonBody(c);
    return c.json(
      staff.update(
        {
          webhookUrl: body.webhookUrl === null ? null : typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined,
          reliability: typeof body.reliability === 'boolean' ? body.reliability : undefined,
          capacity: typeof body.capacity === 'boolean' ? body.capacity : undefined,
          flagLevel: typeof body.flagLevel === 'string' ? (body.flagLevel as 'off' | 'high' | 'medium' | 'low') : undefined,
          // Remember Almanac's own address for links in posts.
          baseUrl: c.req.header('origin') ?? null,
        },
        c.get('session').user.username,
      ),
    );
  });
  app.post('/api/notifications/staff/test', notifications, async (c) => {
    await staff.test();
    return c.json({ ok: true });
  });
  app.post('/api/notifications/channels', notifications, async (c) => {
    const channel = notifier.create(channelInput(await jsonBody(c)), c.get('session').user.username);
    return c.json(channel, 201);
  });
  app.post('/api/notifications/channels/:id', notifications, async (c) => c.json(notifier.update(c.req.param('id'), channelInput(await jsonBody(c)))));
  app.post('/api/notifications/channels/:id/delete', notifications, (c) => {
    notifier.remove(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/notifications/channels/:id/test', notifications, async (c) => c.json(await notifier.test(c.req.param('id'))));
  app.post('/api/notifications/keys', notifications, async (c) => {
    const body = await jsonBody(c);
    const keys = await metadata.setKeys(
      { tmdb: optionalText(body.tmdb), tvdb: optionalText(body.tvdb), tvdbPin: optionalText(body.tvdbPin) },
      c.get('session').user.username,
    );
    return c.json({ keys });
  });

  // The phone app's push notifications, for the phone (sign-in) making the request.
  app.get('/api/app/push', (c) => c.json({ preferences: push.preferences(c.get('session').publicId) }));
  app.post('/api/app/push', async (c) => {
    const session = c.get('session');
    return c.json({ preferences: push.register(session.publicId, session.user.id, await jsonBody(c)) });
  });
  app.post('/api/app/push/preferences', async (c) => c.json({ preferences: push.setPreferences(c.get('session').publicId, await jsonBody(c)) }));
  app.post('/api/app/push/test', async (c) => {
    await push.test(c.get('session').publicId);
    return c.json({ ok: true });
  });
  app.delete('/api/app/push', (c) => {
    push.unregister(c.get('session').publicId);
    return c.json({ ok: true });
  });

  // Suspensions through the billing portal. Mods ask; admins approve. A reason is always required.
  const suspender = (c: { get: (key: 'session') => AuthEnv['Variables']['session'] }): SuspensionActor => {
    const { user } = c.get('session');
    return { id: user.id, name: user.username, role: user.role };
  };
  // Recent alerts for the desktop app, which asks every so often instead of receiving pushes.
  app.get('/api/app/events', (c) => {
    const { user } = c.get('session');
    const after = c.req.query('after');
    return c.json(push.eventsFor({ username: user.username, role: user.role }, after === undefined || after === '' ? null : Number(after) || 0));
  });
  app.get('/api/suspensions/automatic', requirePermission('requestSuspension'), (c) => c.json(autoRequests.view()));
  app.post('/api/suspensions/automatic', requirePermission('reviewSuspension'), async (c) => c.json(autoRequests.update((await jsonBody(c)).kinds, c.get('session').user.username)));
  app.get('/api/suspensions', requirePermission('requestSuspension'), (c) => {
    const status = c.req.query('status');
    return c.json(
      suspensions.list({
        status: ['pending', 'rejected', 'done', 'failed'].includes(status ?? '') ? (status as SuspensionStatus) : undefined,
        userId: c.req.query('user') || undefined,
      }),
    );
  });
  app.post('/api/suspensions', requirePermission('requestSuspension'), async (c) => {
    const body = await jsonBody(c);
    const action = body.action === 'unsuspend' ? 'unsuspend' : body.action === 'suspend' ? 'suspend' : null;
    if (!action || typeof body.userId !== 'string') return c.json({ error: 'Say which account and whether to suspend or unsuspend it.' }, 400);
    return c.json(await suspensions.request(body.userId, action, String(body.reason ?? ''), suspender(c)), 201);
  });
  app.post('/api/suspensions/:id/review', requirePermission('reviewSuspension'), async (c) => {
    const body = await jsonBody(c);
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
    if (!decision) return c.json({ error: 'Approve or reject?' }, 400);
    return c.json(await suspensions.review(Number(c.req.param('id')), decision, String(body.note ?? ''), suspender(c)));
  });
  app.post('/api/suspensions/:id/retry', requirePermission('reviewSuspension'), async (c) => c.json(await suspensions.retry(Number(c.req.param('id')), suspender(c))));
  app.get('/api/billing-portal', requirePermission('configureBilling'), (c) => c.json(suspensions.portal()));
  app.post('/api/billing-portal', requirePermission('configureBilling'), async (c) => {
    const body = await jsonBody(c);
    return c.json(
      suspensions.configure(
        {
          url: body.url === null ? null : typeof body.url === 'string' ? body.url : undefined,
          secret: body.secret === null ? null : typeof body.secret === 'string' ? body.secret : undefined,
          kind: body.kind,
          whmcs: body.whmcs && typeof body.whmcs === 'object' ? (body.whmcs as Record<string, unknown>) : undefined,
        },
        c.get('session').user.username,
      ),
    );
  });
  app.get('/api/billing-portal/api', requirePermission('configureBilling'), (c) => c.json(portalApi.settings()));
  app.post('/api/billing-portal/api/key', requirePermission('configureBilling'), (c) => c.json(portalApi.createKey(c.get('session').user.username)));
  app.post('/api/billing-portal/api/revoke', requirePermission('configureBilling'), (c) => c.json(portalApi.revokeKey(c.get('session').user.username)));
  app.post('/api/billing-portal/api/flags', requirePermission('configureBilling'), async (c) => {
    try {
      return c.json(portalApi.setFlagLevel((await jsonBody(c)).flagLevel, c.get('session').user.username));
    } catch (err) {
      if (err instanceof PortalApiError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
  app.post('/api/billing-portal/test', requirePermission('configureBilling'), async (c) => {
    try {
      return c.json({ ok: true, message: await suspensions.testPortal(c.get('session').user.username) });
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // The built dashboard. Unknown paths fall back to index.html for client-side routing.
  app.use('/*', serveStatic({ root: config.webRoot }));
  app.get('*', serveStatic({ root: config.webRoot, path: 'index.html' }));

  return app;
}
