import { join } from 'node:path';

export interface Config {
  port: number;
  host: string;
  siloUrl: string;
  siloApiKey: string;
  mock: boolean;
  pollIntervalMs: number;
  historySyncIntervalMs: number;
  databasePath: string;
  auth: { username: string; password: string } | null;
  webRoot: string;
}

function bool(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/** Read configuration from environment variables. Throws with a readable message on bad input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const mock = bool(env.SILO_MOCK);

  const siloUrl = (env.SILO_URL ?? '').trim();
  const siloApiKey = (env.SILO_API_KEY ?? '').trim();
  if (!mock) {
    if (!siloUrl) problems.push('SILO_URL is not set (for example https://silo.example.com).');
    else if (!/^https?:\/\//i.test(siloUrl)) problems.push('SILO_URL must start with http:// or https://.');
    if (!siloApiKey) problems.push('SILO_API_KEY is not set.');
  }

  const port = Number(env.PORT ?? 8191);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a number between 1 and 65535.');

  const pollSeconds = Number(env.POLL_INTERVAL_SECONDS ?? 5);
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) problems.push('POLL_INTERVAL_SECONDS must be at least 1.');

  const historySeconds = Number(env.HISTORY_SYNC_SECONDS ?? 60);
  if (!Number.isFinite(historySeconds) || historySeconds < 10) problems.push('HISTORY_SYNC_SECONDS must be at least 10.');

  const username = env.ALMANAC_USERNAME ?? '';
  const password = env.ALMANAC_PASSWORD ?? '';
  if (Boolean(username) !== Boolean(password)) {
    problems.push('Set both ALMANAC_USERNAME and ALMANAC_PASSWORD, or neither.');
  }

  if (problems.length) {
    throw new Error(`Almanac configuration problems:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    siloUrl,
    siloApiKey,
    mock,
    pollIntervalMs: pollSeconds * 1000,
    historySyncIntervalMs: historySeconds * 1000,
    // Demo data gets its own database so it never mixes with real history.
    databasePath: join(env.DATA_DIR ?? 'data', mock ? 'almanac-demo.db' : 'almanac.db'),
    auth: username ? { username, password } : null,
    webRoot: env.ALMANAC_WEB_ROOT ?? 'dist/web',
  };
}
