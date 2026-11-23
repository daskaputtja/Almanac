import { describe, expect, it, vi } from 'vitest';
import { ActivityMonitor } from '../server/activity/monitor.js';
import { createApp } from '../server/app.js';
import { hashPassword, normalizeRecoveryCode, passwordProblem, verifyPassword } from '../server/auth/password.js';
import { FailureLimiter } from '../server/auth/rateLimit.js';
import { AuthService } from '../server/auth/service.js';
import { base32Decode, base32Encode, codeAt, currentStep, verifyCode } from '../server/auth/totp.js';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { HistorySync } from '../server/history/sync.js';
import { LibraryService } from '../server/library/library.js';
import { CatalogSync } from '../server/library/sync.js';
import { MockCatalogSource, MockHistorySource, MockSessionSource } from '../server/silo/mock.js';
import { StatsService } from '../server/stats/stats.js';
import { UsersService } from '../server/users/users.js';

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
  const app = createApp(
    { webRoot: 'dist/web', trustProxy: false, secureCookies: 'auto' },
    {
      auth,
      monitor: new ActivityMonitor(new MockSessionSource(), 60_000, () => {}),
      history,
      historySync: new HistorySync(history, new MockHistorySource(), { intervalMs: 60_000, log: () => {} }),
      stats: new StatsService(db),
      users: new UsersService(db),
      library: new LibraryService(db, catalogSync),
    },
  );
  return { app, auth, db };
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
