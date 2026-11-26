import { describe, expect, it, vi } from 'vitest';
import { ActivityMonitor } from '../server/activity/monitor.js';
import { createApp } from '../server/app.js';
import { hashPassword, normalizeRecoveryCode, passwordProblem, verifyPassword } from '../server/auth/password.js';
import { FailureLimiter } from '../server/auth/rateLimit.js';
import { AuthService } from '../server/auth/service.js';
import { base32Decode, base32Encode, codeAt, currentStep, verifyCode } from '../server/auth/totp.js';
import { openDatabase } from '../server/db/database.js';
import { MetadataService } from '../server/notify/metadata.js';
import { Notifier } from '../server/notify/notifier.js';
import { StaffAlerts } from '../server/notify/staff.js';
import { SuspensionService } from '../server/suspensions/suspensions.js';
import { LibraryBoard } from '../server/notify/board.js';
import { StatusBoard } from '../server/notify/status.js';
import { PushService } from '../server/push/push.js';
import { AccountsService } from '../server/accounts/accounts.js';
import { ReliabilityService } from '../server/reliability/reliability.js';

/** Tests never talk to Discord, TMDB or TVDB. */
const failingFetch = async () => {
  throw new Error('no network in tests');
};
import { HistoryStore } from '../server/history/store.js';
import { HistorySync } from '../server/history/sync.js';
import { LibraryService } from '../server/library/library.js';
import { CatalogSync } from '../server/library/sync.js';
import { ModerationService } from '../server/moderation/service.js';
import { ServerOverviewService } from '../server/server/overview.js';
import { RecapService } from '../server/recap/recap.js';
import { LoadHistory } from '../server/load/load.js';
import { TranscodeDoctor } from '../server/transcodes/doctor.js';
import { TrendingService } from '../server/trending/trending.js';
import { RecapShares } from '../server/recap/shares.js';
import { GeoService } from '../server/geo/geo.js';
import { tmpdir } from 'node:os';
import { MockServerSource } from '../server/silo/mock.js';
import { MockAccountSource, MockCatalogSource, MockHistorySource, MockSessionSource } from '../server/silo/mock.js';
import { StatsService } from '../server/stats/stats.js';
import { UsersService } from '../server/users/users.js';
import { CapacityService } from '../server/capacity/capacity.js';
import { PlaybackHealth } from '../server/health/health.js';
import { PortalApi } from '../server/portal/portal.js';
import { AutoRequests } from '../server/suspensions/auto.js';

describe('TOTP', () => {
  // RFC 6238 appendix B test vectors (SHA-1, 8 digits).
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 test vectors', () => {
    expect(codeAt(secret, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(codeAt(secret, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(codeAt(secret, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(codeAt(secret, Math.floor(2000000000 / 30), 8)).toBe('69279037');
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 7, 99]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('accepts codes within one step and never the same step twice', () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyCode(secret, codeAt(secret, step), null, now)).toBe(step);
    expect(verifyCode(secret, codeAt(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyCode(secret, codeAt(secret, step + 1), null, now)).toBe(step + 1);
    expect(verifyCode(secret, codeAt(secret, step - 2), null, now)).toBeNull();
    // Already used this step: rejected.
    expect(verifyCode(secret, codeAt(secret, step), step, now)).toBeNull();
    expect(verifyCode(secret, 'abcdef', null, now)).toBeNull();
    expect(verifyCode(secret, `${codeAt(secret, step).slice(0, 3)} ${codeAt(secret, step).slice(3)}`, null, now)).toBe(step);
  });
});

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });

  it('explains weak passwords', () => {
    expect(passwordProblem('short', 'alex')).toMatch(/12 characters/);
    expect(passwordProblem('alexalexalexalex', 'alex')).toMatch(/username/);
    expect(passwordProblem('aaaaaaaaaaaaaaaa', 'bob')).toMatch(/variety/);
    expect(passwordProblem('a long passphrase here', 'alex')).toBeNull();
  });

  it('normalises recovery codes', () => {
    expect(normalizeRecoveryCode(' K7MQ-x2tf 9wcd ')).toBe('k7mqx2tf9wcd');
  });
});

describe('FailureLimiter', () => {
  it('blocks after too many failures and forgets them after the window', () => {
    const limiter = new FailureLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) limiter.fail('ip', 1000);
    expect(limiter.retryAfter('ip', 1000)).toBe(60);
    expect(limiter.retryAfter('ip', 62_000)).toBe(0);
    expect(limiter.retryAfter('other', 1000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The whole sign-in flow through the HTTP API.

const PASSWORD = 'a very good passphrase';

function makeApp() {
  const db = openDatabase(':memory:');
  const auth = new AuthService(db);
  const history = new HistoryStore(db);
  const catalogSync = new CatalogSync(db, new MockCatalogSource(), { intervalMs: 60_000, log: () => {} });
  const monitor = new ActivityMonitor(new MockSessionSource(), 60_000, () => {});
  const app = createApp(
    { webRoot: 'dist/web', trustProxy: false, secureCookies: 'auto' },
    {
      auth,
      monitor,
      history,
      historySync: new HistorySync(history, new MockHistorySource(), { intervalMs: 60_000, log: () => {} }),
      stats: new StatsService(db),
      users: new UsersService(db),
      library: new LibraryService(db, catalogSync),
      moderation: new ModerationService(db),
      overview: new ServerOverviewService(db, new MockServerSource()),
      recap: new RecapService(db),
      load: new LoadHistory(db, new MockServerSource(), () => {}),
      transcodes: new TranscodeDoctor(db),
      trending: new TrendingService(db),
      shares: new RecapShares(db, new RecapService(db)),
      geo: new GeoService(db, tmpdir(), () => {}),
      notifier: new Notifier(db, new MockCatalogSource(), new MetadataService(db, failingFetch), { fetchImpl: failingFetch, log: () => {} }),
      metadata: new MetadataService(db, failingFetch),
      accounts: new AccountsService(db, new MockAccountSource(), () => {}),
      reliability: new ReliabilityService(db, new MockServerSource(), null, () => {}),
      capacity: new CapacityService(db, null, () => {}),
      health: new PlaybackHealth(db),
      autoRequests: new AutoRequests(db, new SuspensionService(db, { note: () => {} }, failingFetch), () => {}),
      portalApi: new PortalApi(db, { users: new UsersService(db), moderation: new ModerationService(db), health: new PlaybackHealth(db), monitor, suspensions: new SuspensionService(db, { note: () => {} }, failingFetch), baseUrl: () => null }, () => {}),
      staff: new StaffAlerts(db, failingFetch, () => {}),
      suspensions: new SuspensionService(db, { note: () => {} }, failingFetch),
      board: new LibraryBoard(db, new LibraryService(db, catalogSync), failingFetch, () => {}),
      statusBoard: new StatusBoard(db, failingFetch, () => {}),
      push: new PushService(db, failingFetch, () => {}),
    },
  );
  return { app, auth, db, history, monitor };
}

/** A tiny cookie-keeping client for the app. */
function client(app: ReturnType<typeof makeApp>['app']) {
  let cookie = '';
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(`http://almanac.test${path}`, {
      method,
      headers: {
        ...(method !== 'GET' ? { 'X-Almanac': '1' } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        Host: 'almanac.test',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      cookie = /=$/.test(pair!) || /Max-Age=0/i.test(set) ? '' : pair!;
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json, headers: res.headers };
  };
  return {
    get: (path: string, headers?: Record<string, string>) => request('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => request('POST', path, body ?? {}, headers),
    del: (path: string) => request('DELETE', path),
    get cookie() {
      return cookie;
    },
  };
}

async function setUp() {
  const env = makeApp();
  const c = client(env.app);
  expect((await c.post('/api/auth/setup', { setupCode: env.auth.setupCode, username: 'alex', password: PASSWORD })).status).toBe(200);
  const enroll = await c.get('/api/auth/enroll');
  const secret = enroll.json!.secret as string;
  const step = currentStep();
  const done = await c.post('/api/auth/enroll', { code: codeAt(secret, step) });
  expect(done.status).toBe(200);
  return { ...env, c, secret, step, recoveryCodes: done.json!.recoveryCodes as string[] };
}

describe('sign-in flow', () => {
  it('keeps the API closed until signed in, except health and sign-in', async () => {
    const { app, auth } = makeApp();
    const c = client(app);
    expect((await c.get('/api/health')).status).toBe(200);
    expect((await c.get('/api/activity')).status).toBe(401);
    expect((await c.get('/api/stats')).status).toBe(401);
    expect((await c.get('/api/users')).status).toBe(401);
    const state = await c.get('/api/auth/state');
    expect(state.json).toMatchObject({ setupRequired: true, stage: null });
    expect(auth.hasUsers()).toBe(false);
  });

  it('needs the setup code to create the first account', async () => {
    const { app, auth } = makeApp();
    const c = client(app);
    const wrong = await c.post('/api/auth/setup', { setupCode: 'NOPE-NOPE-NOPE', username: 'alex', password: PASSWORD });
    expect(wrong.status).toBe(403);
    expect(auth.hasUsers()).toBe(false);
    const ok = await c.post('/api/auth/setup', { setupCode: auth.setupCode.toLowerCase(), username: 'alex', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ next: 'enroll' });
    // A second setup is refused.
    expect((await client(app).post('/api/auth/setup', { setupCode: auth.setupCode, username: 'eve', password: PASSWORD })).status).toBe(409);
  });

  it('does not open the API until 2FA is set up', async () => {
    const { app, auth } = makeApp();
    const c = client(app);
    await c.post('/api/auth/setup', { setupCode: auth.setupCode, username: 'alex', password: PASSWORD });
    expect((await c.get('/api/activity')).status).toBe(401);
    const enroll = await c.get('/api/auth/enroll');
    expect(enroll.json!.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Almanac%3Aalex\?secret=/);
    expect(enroll.json!.qrSvg).toMatch(/^<svg/);
    // Asking again gives the same secret until it's confirmed.
    expect((await c.get('/api/auth/enroll')).json!.secret).toBe(enroll.json!.secret);
    expect((await c.post('/api/auth/enroll', { code: '000000' })).status).toBe(401);
  });

  it('completes setup, then signs in with password and code', async () => {
    const { app, c, secret, step, recoveryCodes } = await setUp();
    expect(recoveryCodes).toHaveLength(10);
    expect((await c.get('/api/activity')).status).toBe(200);
    expect((await c.get('/api/auth/state')).json).toMatchObject({ stage: 'full', user: { username: 'alex' }, recoveryCodesLeft: 10 });

    expect((await c.post('/api/auth/logout')).status).toBe(200);
    expect((await c.get('/api/activity')).status).toBe(401);

    const fresh = client(app);
    expect((await fresh.post('/api/auth/login', { username: 'ALEX', password: PASSWORD })).json).toEqual({ next: 'totp' });
    expect((await fresh.get('/api/activity')).status).toBe(401);
    // The code used for setup can't be used again.
    expect((await fresh.post('/api/auth/verify', { code: codeAt(secret, step) })).status).toBe(401);
    expect((await fresh.post('/api/auth/verify', { code: codeAt(secret, step + 1) })).status).toBe(200);
    expect((await fresh.get('/api/activity')).status).toBe(200);
  });

  it('rejects wrong passwords without saying which part was wrong', async () => {
    const { app } = await setUp();
    const c = client(app);
    const wrongPassword = await c.post('/api/auth/login', { username: 'alex', password: 'not the password' });
    const noSuchUser = await c.post('/api/auth/login', { username: 'nobody', password: 'not the password' });
    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.json).toEqual(noSuchUser.json);
  });

  it('accepts each recovery code once', async () => {
    const { app, recoveryCodes } = await setUp();
    const first = client(app);
    await first.post('/api/auth/login', { username: 'alex', password: PASSWORD });
    const ok = await first.post('/api/auth/verify', { recoveryCode: recoveryCodes[0]!.toUpperCase() });
    expect(ok.json).toEqual({ ok: true, usedRecoveryCode: true });
    expect((await first.get('/api/auth/state')).json!.recoveryCodesLeft).toBe(9);

    const second = client(app);
    await second.post('/api/auth/login', { username: 'alex', password: PASSWORD });
    expect((await second.post('/api/auth/verify', { recoveryCode: recoveryCodes[0] })).status).toBe(401);
  });

  it('ends a pending sign-in after five wrong codes', async () => {
    const { app } = await setUp();
    const c = client(app);
    await c.post('/api/auth/login', { username: 'alex', password: PASSWORD });
    for (let i = 0; i < 4; i++) expect((await c.post('/api/auth/verify', { code: '000000' })).status).toBe(401);
    const fifth = await c.post('/api/auth/verify', { code: '000000' });
    expect(fifth.json!.error).toMatch(/password again/);
    expect((await c.get('/api/auth/state')).json!.stage).toBeNull();
  });

  it('rate-limits repeated wrong passwords for a username', async () => {
    const { app } = await setUp();
    for (let i = 0; i < 10; i++) {
      // Different "clients" each time; the per-username limit still applies.
      await client(app).post('/api/auth/login', { username: 'alex', password: `wrong password ${i}` });
    }
    const blocked = await client(app).post('/api/auth/login', { username: 'alex', password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('refuses state-changing requests from other sites', async () => {
    const { app } = await setUp();
    const noHeader = await app.request('http://almanac.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'almanac.test' },
      body: JSON.stringify({ username: 'alex', password: PASSWORD }),
    });
    expect(noHeader.status).toBe(403);
    const foreign = await client(app).post('/api/auth/login', { username: 'alex', password: PASSWORD }, { Origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    const sameSite = await client(app).post('/api/auth/login', { username: 'alex', password: PASSWORD }, { Origin: 'http://almanac.test' });
    expect(sameSite.status).toBe(200);
  });

  it('sets a cookie scripts cannot read, and security headers', async () => {
    const { app, auth } = makeApp();
    const res = await app.request('http://almanac.test/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Almanac': '1', Host: 'almanac.test' },
      body: JSON.stringify({ setupCode: auth.setupCode, username: 'alex', password: PASSWORD }),
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/); // plain http
    expect(res.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const https = await app.request('https://almanac.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Almanac': '1', Host: 'almanac.test' },
      body: JSON.stringify({ username: 'alex', password: PASSWORD }),
    });
    expect(https.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('lists and signs out sessions, and changes the password', async () => {
    const { app, c, secret, step } = await setUp();
    const other = client(app);
    await other.post('/api/auth/login', { username: 'alex', password: PASSWORD });
    await other.post('/api/auth/verify', { code: codeAt(secret, step + 1) });

    const list = await c.get('/api/auth/account/sessions');
    const sessions = list.json!.sessions as { id: string; current: boolean }[];
    expect(sessions).toHaveLength(2);
    const notMine = sessions.find((s) => !s.current)!;
    expect((await c.del(`/api/auth/account/sessions/${notMine.id}`)).status).toBe(200);
    expect((await other.get('/api/activity')).status).toBe(401);

    // The newest code was just used, so wait for the next one, as a person would.
    const later = Date.now() + 31_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    const reused = await c.post('/api/auth/account/password', { currentPassword: PASSWORD, newPassword: 'another fine passphrase', code: codeAt(secret, step + 1) });
    expect(reused.status).toBe(401);
    const changed = await c.post('/api/auth/account/password', {
      currentPassword: PASSWORD,
      newPassword: 'another fine passphrase',
      code: codeAt(secret, currentStep(later) + 1),
    });
    clock.mockRestore();
    expect(changed.status).toBe(200);
    expect((await c.get('/api/activity')).status).toBe(200);
    expect((await client(app).post('/api/auth/login', { username: 'alex', password: PASSWORD })).status).toBe(401);
  });

  it('recovers from the command line', async () => {
    const { app, auth } = await setUp();
    auth.resetTwoFactor('alex');
    const c = client(app);
    expect((await c.post('/api/auth/login', { username: 'alex', password: PASSWORD })).json).toEqual({ next: 'enroll' });
    await auth.resetPassword('alex', 'a brand new passphrase');
    expect((await client(app).post('/api/auth/login', { username: 'alex', password: 'a brand new passphrase' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Roles: admins and mods.

describe('roles', () => {
  /**
   * Each 2FA code works once, so tests that need several codes move a fake
   * clock forward 30 seconds per code, as if someone waited for the next one.
   */
  function clock() {
    let now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    return {
      code: (secret: string) => {
        now += 30_000;
        return codeAt(secret, currentStep(now));
      },
      restore: () => spy.mockRestore(),
    };
  }

  async function withMod() {
    const env = await setUp();
    const history = env.history;
    history.upsert((await new MockHistorySource().listHistoryPage({ limit: 200 })).items);
    await env.auth.addAccount('morgan', PASSWORD, 'mod');
    const mod = client(env.app);
    await mod.post('/api/auth/login', { username: 'morgan', password: PASSWORD });
    const modSecret = (await mod.get('/api/auth/enroll')).json!.secret as string;
    await mod.post('/api/auth/enroll', { code: codeAt(modSecret, currentStep()) });
    return { ...env, admin: env.c, adminSecret: env.secret, mod };
  }

  it('makes existing and first accounts admins', async () => {
    const { c } = await setUp();
    const state = (await c.get('/api/auth/state')).json!;
    expect(state.role).toBe('admin');
    expect(state.permissions).toEqual(['viewIpAddresses', 'manageAccounts', 'manageNotifications', 'moderate', 'manageAllNotes', 'configureFlags', 'shareRecaps', 'requestSuspension', 'reviewSuspension', 'configureBilling', 'configureCapacity']);
  });

  it('tells a mod what they can do', async () => {
    const { mod } = await withMod();
    const state = (await mod.get('/api/auth/state')).json!;
    expect(state).toMatchObject({ stage: 'full', role: 'mod', permissions: ['moderate', 'shareRecaps', 'requestSuspension'] });
  });

  it('removes IP addresses from live activity for mods', async () => {
    const { admin, mod, monitor } = await withMod();
    await monitor.poll();
    type Streams = { client: { ip: string | null } }[];
    const adminStreams = (await admin.get('/api/activity')).json!.streams as Streams;
    const modStreams = (await mod.get('/api/activity')).json!.streams as Streams;
    expect(adminStreams.length).toBeGreaterThan(0);
    expect(adminStreams.some((s) => s.client.ip)).toBe(true);
    expect(modStreams).toHaveLength(adminStreams.length);
    expect(modStreams.every((s) => s.client.ip === null)).toBe(true);
  });

  it('strips IPs from snapshots sent to mods', async () => {
    const { withoutIps } = await import('../server/app.js');
    const monitor = new ActivityMonitor(new MockSessionSource(), 60_000, () => {});
    await monitor.poll();
    const full = monitor.current();
    expect(full.streams.some((s) => s.client.ip)).toBe(true);
    const stripped = withoutIps(full);
    expect(stripped.streams.every((s) => s.client.ip === null)).toBe(true);
    expect(full.streams.some((s) => s.client.ip)).toBe(true); // the original is untouched
  });

  it('hides IPs in history from mods, including from search', async () => {
    const { admin, mod } = await withMod();
    const adminPage = (await admin.get('/api/history?pageSize=100')).json!;
    const modPage = (await mod.get('/api/history?pageSize=100')).json!;
    const ips = (page: Record<string, unknown>) => (page.items as { client: { ip: string | null } }[]).map((i) => i.client.ip);
    expect(ips(adminPage).some(Boolean)).toBe(true);
    expect(ips(modPage).every((ip) => ip === null)).toBe(true);

    // Searching by IP finds plays for admins but nothing for mods.
    expect((await admin.get('/api/history?search=203.0.113')).json!.total).toBeGreaterThan(0);
    expect((await mod.get('/api/history?search=203.0.113')).json!.total).toBe(0);
    // Ordinary searches still work for mods.
    expect((await mod.get('/api/history?search=harbour')).json!.total).toBeGreaterThan(0);
  });

  it('hides a user’s IP addresses from mods', async () => {
    const { admin, mod } = await withMod();
    const someone = ((await admin.get('/api/users')).json!.users as { id: string; plays: number }[]).find((u) => u.plays > 0)!;
    expect(((await admin.get(`/api/users/${someone.id}`)).json!.addresses as unknown[]).length).toBeGreaterThan(0);
    expect((await mod.get(`/api/users/${someone.id}`)).json!.addresses).toEqual([]);
  });

  it('opens moderation to mods and admins, but not to signed-out visitors', async () => {
    const { app, admin, mod } = await withMod();
    expect((await client(app).get('/api/moderation/flags')).status).toBe(401);
    expect((await mod.get('/api/moderation/flags')).status).toBe(200);
    expect((await admin.get('/api/moderation/flags')).status).toBe(200);

    expect((await mod.post('/api/moderation/users/100/tags', { tags: ['VIP', 'Warned'] })).json).toEqual({ tags: ['VIP', 'Warned'] });
    expect((await admin.get('/api/moderation/tags')).json!.byUser).toEqual({ '100': ['VIP', 'Warned'] });
    expect((await mod.post('/api/moderation/users/100/notes', { body: 'Hello' })).status).toBe(201);
    const notes = (await admin.get('/api/moderation/users/100/notes')).json!.notes as { id: number; canEdit: boolean }[];
    expect(notes[0]!.canEdit).toBe(true); // admins can edit anyone's notes
    expect((await mod.post('/api/moderation/notes/999/delete')).status).toBe(404);
  });

  it('lets mods read the flag thresholds but only admins change them', async () => {
    const { admin, mod } = await withMod();
    expect((await mod.get('/api/moderation/thresholds')).status).toBe(200);
    const body = { thresholds: { concurrentNetworks: { enabled: true, medium: 4, high: 5 } } };
    expect((await mod.post('/api/moderation/thresholds', body)).status).toBe(403);
    expect((await mod.post('/api/moderation/thresholds/preview', body)).status).toBe(403);
    expect((await admin.post('/api/moderation/thresholds/preview', body)).status).toBe(200);
    expect((await admin.post('/api/moderation/thresholds', { thresholds: { concurrentNetworks: { enabled: true, medium: 5, high: 4 } } })).status).toBe(400);
    const saved = await admin.post('/api/moderation/thresholds', body);
    expect(saved.status).toBe(200);
    expect((saved.json!.thresholds as Record<string, unknown>).concurrentNetworks).toEqual({ enabled: true, medium: 4, high: 5 });
    expect(saved.json!.updatedBy).toBe('alex');
  });

  it('shows recaps to signed-in admins and mods', async () => {
    const { app, admin, mod } = await withMod();
    expect((await client(app).get('/api/recap?year=2026')).status).toBe(401);
    expect((await mod.get('/api/recap?year=2026')).status).toBe(200);
    expect((await admin.get('/api/recap?year=2026&user=nobody')).status).toBe(404);
    expect((await admin.get('/api/recap?year=12')).status).toBe(400);
  });

  it('shares a recap through a private link, until it’s revoked', async () => {
    const { app, mod, history } = await withMod();
    const year = new Date().getFullYear();
    const userId = (history.query({ pageSize: 1 }).items[0]!).user.id;
    expect((await client(app).post('/api/recap/shares', { user: userId, year })).status).toBe(401);

    const created = await mod.post('/api/recap/shares', { user: userId, year });
    expect(created.status).toBe(201);
    const path = created.json!.path as string;
    expect(path).toMatch(/^\/r\/[A-Za-z0-9_-]{20,}$/);

    // Anyone with the link, signed in or not, sees just that recap.
    const visitor = client(app);
    const opened = await visitor.get(`/api/public/recap/${path.slice(3)}`);
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ scope: 'user', year, availableYears: [year], server: null });
    expect((opened.json!.user as { id: string; name: string }).id).toBe('');
    expect((await visitor.get('/api/activity')).status).toBe(401);
    expect((await visitor.get(`/api/recap?year=${year}&user=${userId}`)).status).toBe(401);

    const list = (await mod.get(`/api/recap/shares?user=${userId}`)).json!.shares as { id: string; views: number }[];
    expect(list[0]!.views).toBe(1);

    expect((await mod.post(`/api/recap/shares/${list[0]!.id}/revoke`)).status).toBe(200);
    expect((await visitor.get(`/api/public/recap/${path.slice(3)}`)).status).toBe(404);
    expect((await visitor.get('/api/public/recap/not-a-real-token-at-all')).status).toBe(404);
  });

  it('shows cities on the map to admins only', async () => {
    const { admin, mod } = await withMod();
    expect((await mod.get('/api/stats/map')).status).toBe(200);
    expect((await mod.get('/api/stats/map')).json!.cities).toEqual([]);
    expect((await admin.get('/api/stats/map')).status).toBe(200);
  });

  it('keeps Discord notifications for admins, and never shows webhook secrets', async () => {
    const { admin, mod } = await withMod();
    expect((await mod.get('/api/notifications')).status).toBe(403);
    expect((await mod.post('/api/notifications/keys', { tmdb: 'x' })).status).toBe(403);
    expect((await admin.get('/api/notifications')).status).toBe(200);

    const secret = 'S3cretWebhookTokenPart_abcdefghijklmnop';
    const created = await admin.post('/api/notifications/channels', {
      name: '#4k-movies',
      webhookUrl: `https://discord.com/api/webhooks/123456789012345678/${secret}`,
      libraryIds: ['3'],
      quality: 'dolby_vision',
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: '#4k-movies', webhookHint: 'discord.com/api/webhooks/…5678', quality: 'dolby_vision' });
    const listed = await admin.get('/api/notifications');
    expect(JSON.stringify(listed.json)).not.toContain(secret);
    expect((await mod.post(`/api/notifications/channels/${created.json!.id}/delete`)).status).toBe(403);

    const bad = await admin.post('/api/notifications/channels', { name: 'x', webhookUrl: 'https://evil.example/api/webhooks/1/2', libraryIds: ['3'] });
    expect(bad.status).toBe(400);
    expect(bad.json!.error).toMatch(/Discord webhook/);
  });

  it('lets mods ask for suspensions but only admins approve them or set up the portal', async () => {
    const { admin, mod } = await withMod();
    expect((await mod.get('/api/suspensions')).status).toBe(200);
    expect((await mod.post('/api/suspensions/1/review', { decision: 'approve', note: '' })).status).toBe(403);
    expect((await mod.get('/api/billing-portal')).status).toBe(403);
    expect((await mod.post('/api/billing-portal', { url: 'https://evil.example' })).status).toBe(403);
    const saved = await admin.post('/api/billing-portal', { url: 'https://billing.example/almanac', secret: 'x'.repeat(40) });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.json)).not.toContain('x'.repeat(40)); // the secret is never sent back
    expect(saved.json).toMatchObject({ url: 'https://billing.example/almanac', secretSet: true });
  });

  it('keeps account management for admins', async () => {
    const { mod } = await withMod();
    expect((await mod.get('/api/auth/accounts')).status).toBe(403);
    expect((await mod.post('/api/auth/accounts', { code: '000000', username: 'eve', password: PASSWORD, role: 'admin' })).status).toBe(403);
  });

  it('lets admins add accounts, with their 2FA code', async () => {
    const { admin, adminSecret, app } = await withMod();
    const t = clock();
    try {
      expect((await admin.post('/api/auth/accounts', { code: '000000', username: 'sam', password: PASSWORD, role: 'mod' })).status).toBe(401);
      const added = await admin.post('/api/auth/accounts', { code: t.code(adminSecret), username: 'sam', password: PASSWORD, role: 'mod' });
      expect(added.status).toBe(201);
      expect(added.json!.account).toMatchObject({ username: 'sam', role: 'mod', totpEnabled: false });
      // The new account sets up 2FA at first sign-in.
      expect((await client(app).post('/api/auth/login', { username: 'sam', password: PASSWORD })).json).toEqual({ next: 'enroll' });
    } finally {
      t.restore();
    }
  });

  it('applies role changes straight away', async () => {
    const { admin, adminSecret, mod } = await withMod();
    const t = clock();
    try {
      const accounts = (await admin.get('/api/auth/accounts')).json!.accounts as { id: number; username: string }[];
      const morgan = accounts.find((a) => a.username === 'morgan')!;
      expect((await admin.post(`/api/auth/accounts/${morgan.id}/role`, { code: t.code(adminSecret), role: 'admin' })).status).toBe(200);
      expect((await mod.get('/api/auth/accounts')).status).toBe(200);
      expect((await admin.post(`/api/auth/accounts/${morgan.id}/role`, { code: t.code(adminSecret), role: 'mod' })).status).toBe(200);
      expect((await mod.get('/api/auth/accounts')).status).toBe(403);
    } finally {
      t.restore();
    }
  });

  it('never leaves Almanac without an admin', async () => {
    const { admin, adminSecret } = await withMod();
    const t = clock();
    try {
      const body = (await admin.get('/api/auth/accounts')).json!;
      const me = body.currentId as number;
      const demote = await admin.post(`/api/auth/accounts/${me}/role`, { code: t.code(adminSecret), role: 'mod' });
      expect(demote.status).toBe(409);
      expect(demote.json!.error).toMatch(/only admin/);
      expect((await admin.post(`/api/auth/accounts/${me}/delete`, { code: t.code(adminSecret) })).status).toBe(409);
    } finally {
      t.restore();
    }
  });

  it('signs out a deleted account immediately', async () => {
    const { admin, adminSecret, mod } = await withMod();
    const t = clock();
    try {
      const morgan = ((await admin.get('/api/auth/accounts')).json!.accounts as { id: number; username: string }[]).find((a) => a.username === 'morgan')!;
      expect((await admin.post(`/api/auth/accounts/${morgan.id}/delete`, { code: t.code(adminSecret) })).status).toBe(200);
      expect((await mod.get('/api/activity')).status).toBe(401);
    } finally {
      t.restore();
    }
  });
});

describe('phone app sign-in', () => {
  /** A request as the phone app makes it: no cookie, no website header, the token in Authorization. */
  const fromApp = async (app: ReturnType<typeof makeApp>['app'], method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(`http://almanac.test${path}`, {
      method,
      headers: {
        'X-Almanac-Client': 'app',
        'User-Agent': 'Almanac app/1.0 (iPhone)',
        Host: 'almanac.test',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null, cookie: res.headers.get('set-cookie') };
  };

  it('signs in with a password and a 2FA code, then uses its own token', async () => {
    const env = await setUp();
    let now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      expect((await fromApp(env.app, 'GET', '/api/app/info')).json).toMatchObject({ app: 'almanac', apiVersion: 1 });

      const login = await fromApp(env.app, 'POST', '/api/auth/login', { username: 'alex', password: PASSWORD });
      expect(login.json).toMatchObject({ next: 'totp' });
      expect(login.cookie).toBeNull(); // the app gets a token, not a cookie
      const pending = login.json!.token as string;
      expect((await fromApp(env.app, 'GET', '/api/activity', undefined, pending)).status).toBe(401); // not until the 2FA code

      now += 30_000;
      const verified = await fromApp(env.app, 'POST', '/api/auth/verify', { code: codeAt(env.secret, currentStep(now)) }, pending);
      expect(verified.status).toBe(200);
      const token = verified.json!.token as string;
      expect(token).toBeTruthy();
      expect((await fromApp(env.app, 'GET', '/api/activity', undefined, token)).status).toBe(200);
      // Changes work without the website's anti-forgery header.
      expect((await fromApp(env.app, 'POST', '/api/app/push', { pushToken: 'ExponentPushToken[abcdefghijklmnop]', platform: 'ios' }, token)).status).toBe(200);

      // It shows in Settings as the app, and signing it out there locks it out.
      const sessions = (await env.c.get('/api/auth/account/sessions')).json!.sessions as { id: string; app: boolean; current: boolean }[];
      const phone = sessions.find((x) => x.app)!;
      expect(phone).toBeTruthy();
      expect((await env.c.del(`/api/auth/account/sessions/${phone.id}`)).status).toBe(200);
      expect((await fromApp(env.app, 'GET', '/api/activity', undefined, token)).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('still needs the website header for cookie sign-ins', async () => {
    const env = await setUp();
    const res = await env.app.request('http://almanac.test/api/moderation/tags', { method: 'POST', headers: { Cookie: env.c.cookie, Host: 'almanac.test' } });
    expect(res.status).toBe(403);
  });
});

describe('portal API', () => {
  function seed(db: ReturnType<typeof makeApp>['db']) {
    db.prepare("INSERT INTO silo_users (id, username, email, enabled, created_at, synced_at) VALUES ('42', 'pike', 'pike@example.com', 1, '2026-01-01T00:00:00Z', ?)").run(new Date().toISOString());
    const insert = db.prepare(
      `INSERT INTO plays (session_id, user_id, username, profile_id, media_type, title, started_at, ended_at, end_position,
         watched_seconds, completed, play_method, client_name, device_id, client_ip, end_reason, imported_at)
       VALUES (?, '42', 'pike', 'p', 'movie', 'T', ?, ?, 0, 3600, 0, 'direct', 'Silo Android TV', ?, ?, 'stopped', ?)`,
    );
    const t = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    insert.run('s1', t(5), t(4), 'tv', '203.0.113.10', t(0));
    insert.run('s2', t(4.5), t(3.5), 'phone', '198.51.100.4', t(0));
    insert.run('s3', t(30), t(29), 'tv', '203.0.113.10', t(0));
  }

  it('stays closed without the portal’s key, and limits wrong guesses', async () => {
    const { app } = makeApp();
    const c = client(app);
    expect((await c.get('/api/portal/v1')).status).toBe(401);
    expect((await c.get('/api/portal/v1', { Authorization: 'Bearer alm_wrong' })).status).toBe(401);
    for (let i = 0; i < 20; i++) await c.get('/api/portal/v1', { Authorization: 'Bearer alm_wrong' });
    expect((await c.get('/api/portal/v1', { Authorization: 'Bearer alm_wrong' })).status).toBe(429);
  });

  it('looks customers up, reports usage, takes events, and never gives out addresses', async () => {
    const { c, db, app } = await setUp();
    seed(db);
    const made = await c.post('/api/billing-portal/api/key');
    expect(made.status).toBe(200);
    const key = made.json!.key as string;
    expect(key).toMatch(/^alm_/);
    expect((made.json!.settings as { keyHint: string }).keyHint).toBe(key.slice(-4));

    const portal = client(app);
    const auth = { Authorization: `Bearer ${key}` };
    expect((await portal.get('/api/portal/v1', auth)).json).toEqual({ app: 'almanac', apiVersion: 1 });

    const found = await portal.get('/api/portal/v1/customers?email=PIKE@example.com', auth);
    expect(found.status).toBe(200);
    const customer = found.json!.customer as Record<string, unknown>;
    expect(customer).toMatchObject({ id: '42', username: 'pike', email: 'pike@example.com', enabled: true, watchingNow: 0 });
    expect(customer.usage).toMatchObject({ days: 30, plays: 3, hoursWatched: 3, peakStreams: 2, devicesUsed: 2 });
    expect(JSON.stringify(found.json)).not.toMatch(/203\.0\.113|198\.51\.100/);
    expect((await portal.get('/api/portal/v1/customers?username=nobody', auth)).status).toBe(404);
    expect((await portal.get('/api/portal/v1/customers', auth)).status).toBe(400);

    const usage = await portal.get('/api/portal/v1/customers/42/usage?days=1', auth);
    expect(usage.json).toMatchObject({ id: '42', usage: { days: 1, plays: 2, peakStreams: 2 } });
    expect((await portal.get('/api/portal/v1/customers/42/usage?days=900', auth)).status).toBe(400);
    const all = await portal.get('/api/portal/v1/usage', auth);
    expect((all.json!.customers as { id: string }[]).map((x) => x.id)).toEqual(['42']);

    // The portal says what it did: it lands in the notes, by "Billing portal".
    const event = await portal.post('/api/portal/v1/events', { customer: { username: 'PIKE' }, type: 'suspended', detail: 'Non-payment' }, auth);
    expect(event.status).toBe(201);
    const notes = (await c.get('/api/moderation/users/42/notes')).json!.notes as { authorName: string; body: string }[];
    expect(notes[0]).toMatchObject({ authorName: 'Billing portal', body: 'Suspended: Non-payment' });
    await portal.post('/api/portal/v1/events', { customer: { id: '42' }, type: 'plan_changed', plan: '4 streams' }, auth);
    expect(((await c.get('/api/moderation/users/42/notes')).json!.notes as { body: string }[])[0]!.body).toBe('Plan changed to 4 streams.');
    expect((await portal.post('/api/portal/v1/events', { customer: { id: '42' }, type: 'deleted' }, auth)).status).toBe(400);
    expect((await portal.post('/api/portal/v1/events', { customer: { email: 'x@example.com' }, type: 'note', detail: 'hi' }, auth)).status).toBe(404);

    // A session cookie isn't a key, and a turned-off key stops working.
    expect((await c.get('/api/portal/v1')).status).toBe(401);
    await c.post('/api/billing-portal/api/revoke');
    expect((await portal.get('/api/portal/v1', auth)).status).toBe(401);
  });

  it('sends flags to the portal at the chosen level, signed', async () => {
    const db = openDatabase(':memory:');
    const sent: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      sent.push({ body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      return new Response('{"message":"ok"}', { status: 200 });
    };
    const suspensions = new SuspensionService(db, { note: () => {} }, fetchImpl);
    suspensions.configure({ url: 'https://billing.example.com/almanac', secret: 'x'.repeat(32) }, 'admin');
    const monitor = new ActivityMonitor(new MockSessionSource(), 60_000, () => {});
    const portalApi = new PortalApi(db, { users: new UsersService(db), moderation: new ModerationService(db), health: new PlaybackHealth(db), monitor, suspensions, baseUrl: () => 'https://almanac.example' }, () => {});
    const event = (severity: 'low' | 'medium' | 'high') => ({
      reason: 'new' as const,
      userId: '42',
      username: 'pike',
      email: 'pike@example.com',
      kind: 'bulk_opening' as const,
      severity,
      headline: 'Opened 244 different titles in a day without watching them',
      details: ['Between {{time:2026-11-19T12:33:00.000Z}} and later.'],
    });
    expect(await portalApi.flagEvents([event('high')])).toBe(0); // off by default
    portalApi.setFlagLevel('medium', 'admin');
    expect(await portalApi.flagEvents([event('low'), event('high')])).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      event: 'flag',
      customer: { id: '42', username: 'pike', email: 'pike@example.com' },
      flag: { kind: 'bulk_opening', group: 'ripping', severity: 'high', details: ['Between 2026-11-19T12:33:00.000Z and later.'] },
      almanac_url: 'https://almanac.example/users/42',
    });
    expect(sent[0]!.headers['X-Almanac-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(() => portalApi.setFlagLevel('loud', 'admin')).toThrow(/Unknown/);
  });
});
