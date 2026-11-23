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
import { MockCatalogSource, MockHistorySource, MockSessionSource } from './silo/mock.js';
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

const app = createApp(config, { auth, monitor, history, historySync, stats, users, library, moderation });
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
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
