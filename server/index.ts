import { serve } from '@hono/node-server';
import { ActivityMonitor } from './activity/monitor.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { SiloClient, type SessionSource } from './silo/client.js';
import { MockSessionSource } from './silo/mock.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const source: SessionSource = config.mock
  ? new MockSessionSource()
  : new SiloClient(config.siloUrl, config.siloApiKey);

const monitor = new ActivityMonitor(source, config.pollIntervalMs);
monitor.start();

const app = createApp(config, monitor);
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Almanac is running on http://localhost:${info.port}`);
  console.log(config.mock ? 'Using mock Silo data.' : `Watching Silo at ${config.siloUrl}`);
  if (!config.auth) {
    console.log('Warning: no ALMANAC_USERNAME/ALMANAC_PASSWORD set, so the dashboard is open to anyone who can reach it.');
  }
});

function shutdown() {
  monitor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
