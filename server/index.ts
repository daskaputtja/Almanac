import { serve } from '@hono/node-server';
import { ActivityMonitor } from './activity/monitor.js';
import { createApp } from './app.js';
import { AuthService } from './auth/service.js';
import { loadConfig } from './config.js';
import { type Database, openDatabase } from './db/database.js';
import { HistoryStore } from './history/store.js';
import { HistorySync } from './history/sync.js';
import { LibraryService } from './library/library.js';
import { CatalogSync } from './library/sync.js';
import { type CatalogSource, type HistorySource, type SessionSource, SiloClient } from './silo/client.js';
import { MockAccountSource, MockCatalogSource, MockHistorySource, MockServerSource, MockSessionSource } from './silo/mock.js';
import { ServerOverviewService } from './server/overview.js';
import { RecapService } from './recap/recap.js';
import { RecapShares } from './recap/shares.js';
import { GeoService } from './geo/geo.js';
import { MetadataService } from './notify/metadata.js';
import { Notifier } from './notify/notifier.js';
import { StaffAlerts } from './notify/staff.js';
import { LibraryBoard } from './notify/board.js';
import { StatusBoard } from './notify/status.js';
import { PushService } from './push/push.js';
import { AccountsService } from './accounts/accounts.js';
import { ReliabilityService } from './reliability/reliability.js';
import { SuspensionService } from './suspensions/suspensions.js';
import { dirname } from 'node:path';
import { LoadHistory } from './load/load.js';
import { TranscodeDoctor } from './transcodes/doctor.js';
import { TrendingService } from './trending/trending.js';
import { StatsService } from './stats/stats.js';
import { UsersService } from './users/users.js';
import { ModerationService } from './moderation/service.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const silo = config.mock ? null : new SiloClient(config.siloUrl, config.siloApiKey);
const sessionSource: SessionSource = silo ?? new MockSessionSource();
const historySource: HistorySource = silo ?? new MockHistorySource();
const catalogSource: CatalogSource = silo ?? new MockCatalogSource();

let db: Database;
try {
  db = openDatabase(config.databasePath);
} catch (err) {
  console.error(`Could not open the database at ${config.databasePath}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const history = new HistoryStore(db);
const historySync = new HistorySync(history, historySource, { intervalMs: config.historySyncIntervalMs });
historySync.start();

const monitor = new ActivityMonitor(sessionSource, config.pollIntervalMs);
// When a stream disappears from the activity list it has ended, so fetch its history soon.
let liveIds = new Set<string>();
monitor.subscribe((snapshot) => {
  if (snapshot.error) return;
  const ids = new Set(snapshot.streams.map((s) => s.id));
  if ([...liveIds].some((id) => !ids.has(id))) historySync.trigger();
  liveIds = ids;
});
monitor.start();

const catalogSync = new CatalogSync(db, catalogSource, { intervalMs: config.catalogSyncIntervalMs });
catalogSync.start();

const stats = new StatsService(db);
const users = new UsersService(db);
const library = new LibraryService(db, catalogSync);

const auth = new AuthService(db);
if (!auth.hasUsers() && config.bootstrapUser) {
  try {
    await auth.createUser(config.bootstrapUser.username, config.bootstrapUser.password);
    console.log(`Created the Almanac account "${config.bootstrapUser.username}". Set up two-factor authentication when you first sign in.`);
  } catch (err) {
    console.error(`Could not create the account from ALMANAC_USERNAME/ALMANAC_PASSWORD: ${err instanceof Error ? err.message : err}`);
  }
}

// Account flags: re-checked every 5 minutes, using the week's history and what's playing now.
const moderation = new ModerationService(db);
const runModerationChecks = () => {
  try {
    const live = new Map<string, { ip: string | null; player: string | null }[]>();
    for (const s of monitor.current().streams) {
      const list = live.get(s.user.id) ?? [];
      list.push({ ip: s.client.ip, player: s.client.name });
      live.set(s.user.id, list);
    }
    moderation.refresh(live);
  } catch (err) {
    console.error(`Account checks failed: ${err instanceof Error ? err.message : err}`);
  }
};
setTimeout(runModerationChecks, 15_000).unref();
const moderationTimer = setInterval(runModerationChecks, 5 * 60_000);

const serverSource = silo ?? new MockServerSource();
const overview = new ServerOverviewService(db, serverSource);
overview.start();
const load = new LoadHistory(db, serverSource);
load.start();

// Record why live streams are converted (history doesn't keep it).
const transcodes = new TranscodeDoctor(db);
monitor.subscribe((snapshot) => {
  if (snapshot.error) return;
  try {
    transcodes.record(snapshot.streams);
  } catch (err) {
    console.error(`Recording stream details failed: ${err instanceof Error ? err.message : err}`);
  }
});

const recap = new RecapService(db);

// Where viewers watch from: a local copy of DB-IP's free database (GEOLOCATION=off to disable).
const geo = new GeoService(db, dirname(config.databasePath));
if (config.geolocation) geo.start();

// Recently added posts to Discord, with TMDB and TVDB details when keys are set.
const metadata = new MetadataService(db);
const notifier = new Notifier(db, catalogSource, metadata);
notifier.start();

// Offline downloads and signed-in devices, copied from Silo every 10 minutes.
const accounts = new AccountsService(db, silo ?? new MockAccountSource());
accounts.start();

// How reliably streams play, with an optional alert to a staff Discord channel.
const staff = new StaffAlerts(db);
const reliability = new ReliabilityService(db, serverSource, staff);
// A Discord message listing every library and how much is in it, edited hourly.
const board = new LibraryBoard(db, library);
board.start();
// Server status from an Uptime Kuma status page, as a Discord message.
const statusBoard = new StatusBoard(db);
statusBoard.start();

// Push notifications to the phone app, through Expo.
const push = new PushService(db, fetch, console.log, process.env.EXPO_ACCESS_TOKEN?.trim() || null);
const quietly = (p: Promise<unknown>) => void p.catch((err) => console.log(`Push notification not sent: ${err instanceof Error ? err.message : String(err)}`));
reliability.onAlert = (message) => quietly(push.serverAlert(message));
statusBoard.onChange = (changes) => {
  for (const m of changes) {
    quietly(push.serverAlert({ title: m.state === 'down' ? `${m.name} is down` : `${m.name} is back up`, body: m.state === 'down' ? 'Uptime Kuma says it isn’t answering.' : 'Uptime Kuma says it’s answering again.', path: '/server' }));
  }
};

// Suspensions go through the billing portal; notes record every step.
const suspensions = new SuspensionService(db, {
  onPending: (r) => quietly(push.suspensionRequested(r)),
  onDecided: (r) => quietly(push.suspensionDecided(r)),
  note: (userId, actor, text) => moderation.addNote(userId, { id: actor.id, name: actor.name, manageAllNotes: false }, text),
  tellStaff: (embed) => staff.post(embed),
  baseUrl: () => staff.baseUrl(),
});
moderation.onFlagEvents((events) => {
  staff.flagAlerts(events).catch((err) => console.log(`Flag alert not sent: ${err instanceof Error ? err.message : String(err)}`));
  quietly(push.flagEvents(events));
});
reliability.start();

const app = createApp(config, { auth, monitor, history, historySync, stats, users, library, moderation, overview, recap, load, transcodes, trending: new TrendingService(db), shares: new RecapShares(db, recap), geo, notifier, metadata, accounts, reliability, staff, suspensions, board, statusBoard, push });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Almanac is running on http://localhost:${info.port}`);
  console.log(config.mock ? 'Using mock Silo data.' : `Watching Silo at ${config.siloUrl}`);
  console.log(`Database: ${config.databasePath}`);
  if (!auth.hasUsers()) {
    console.log('');
    console.log('  No account yet. Open Almanac in your browser to create one.');
    console.log(`  You'll need this setup code: ${auth.setupCode}`);
    console.log('');
  }
});

function shutdown() {
  monitor.stop();
  historySync.stop();
  catalogSync.stop();
  clearInterval(moderationTimer);
  overview.stop();
  load.stop();
  geo.stop();
  notifier.stop();
  accounts.stop();
  board.stop();
  statusBoard.stop();
  reliability.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
