import { serve } from '@hono/node-server';
import { ActivityMonitor } from './activity/monitor.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { type Database, openDatabase } from './db/database.js';
import { HistoryStore } from './history/store.js';
import { HistorySync } from './history/sync.js';
import { type HistorySource, type SessionSource, SiloClient } from './silo/client.js';
import { MockHistorySource, MockSessionSource } from './silo/mock.js';

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

const app = createApp(config, { monitor, history, historySync });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Almanac is running on http://localhost:${info.port}`);
  console.log(config.mock ? 'Using mock Silo data.' : `Watching Silo at ${config.siloUrl}`);
  console.log(`Database: ${config.databasePath}`);
  if (!config.auth) {
    console.log('Warning: no ALMANAC_USERNAME/ALMANAC_PASSWORD set, so the dashboard is open to anyone who can reach it.');
  }
});

function shutdown() {
  monitor.stop();
  historySync.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
