import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import QRCode from 'qrcode';
import { type Permission, can, isRole, permissionsFor } from '../../shared/permissions.js';
import { FailureLimiter } from './rateLimit.js';
import { AuthError, type AuthService, type ClientInfo, type Session } from './service.js';
import { otpauthUrl } from './totp.js';

export const SESSION_COOKIE = 'almanac_session';
/** Every request that changes something must carry this header. Browsers won't let another site add it. */
export const CSRF_HEADER = 'x-almanac';

export interface AuthOptions {
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy: boolean;
  /** `auto` marks cookies Secure when the request came over HTTPS. */
  secureCookies: 'auto' | 'always' | 'never';
}

export type AuthEnv = { Variables: { session: Session; token: string } };
type Env = AuthEnv;

/** Refuse with 403 unless the signed-in account's role has `permission`. Use after requireSession. */
export function requirePermission(permission: Permission): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!can(c.get('session').user.role, permission)) return c.json({ error: 'Your account doesn’t have access to this.' }, 403);
    return next();
  };
}

/** Pending sign-ins live 10 minutes; full sessions 30 days. The cookie lasts as long. */
const COOKIE_MAX_AGE = { pending: 10 * 60, full: 30 * 86_400 };

export function createAuth(auth: AuthService, options: AuthOptions) {
  // Wrong passwords and codes: per IP address and per username.
  const ipFailures = new FailureLimiter(20, 15 * 60_000);
  const userFailures = new FailureLimiter(10, 15 * 60_000);

  const client = (c: Context): ClientInfo => {
    let ip: string | null = null;
    if (options.trustProxy) ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null;
    if (!ip) {
      try {
        ip = getConnInfo(c).remote.address ?? null;
      } catch {
        ip = null; // not running under the Node server (tests)
      }
    }
    return { ip, userAgent: c.req.header('user-agent') ?? null };
  };

  const isHttps = (c: Context) => {
    if (options.secureCookies === 'always') return true;
    if (options.secureCookies === 'never') return false;
    if (options.trustProxy && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') return true;
    return new URL(c.req.url).protocol === 'https:';
  };

  const setSessionCookie = (c: Context, token: string, full: boolean) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(c),
      path: '/',
      maxAge: full ? COOKIE_MAX_AGE.full : COOKIE_MAX_AGE.pending,
    });

  /** Refuse with 429 if this IP (or username) has failed too often. */
  const checkLimits = (c: Context, username?: string) => {
    const ip = client(c).ip ?? 'unknown';
    const wait = Math.max(ipFailures.retryAfter(ip), username ? userFailures.retryAfter(username.toLowerCase()) : 0);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      throw new AuthError(`Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.`, 429);
    }
  };
  const recordFailure = (c: Context, username?: string) => {
    ipFailures.fail(client(c).ip ?? 'unknown');
    if (username) userFailures.fail(username.toLowerCase());
  };

  const body = async <T,>(c: Context): Promise<Partial<T>> => {
    try {
      return (await c.req.json()) as Partial<T>;
    } catch {
      return {};
    }
  };
  const str = (value: unknown) => (typeof value === 'string' ? value : '');

  /**
   * Cross-site request protection for anything that changes state: the custom
   * header can't be sent by another site without a CORS preflight (which we
   * never approve), and if the browser says where the request came from, it
   * must be this site.
   */
  const csrf: MiddlewareHandler = async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    if (c.req.header(CSRF_HEADER) !== '1') return c.json({ error: 'Missing request header.' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      const host = (options.trustProxy && c.req.header('x-forwarded-host')) || c.req.header('host');
      try {
        if (new URL(origin).host !== host) return c.json({ error: 'Cross-site request refused.' }, 403);
      } catch {
        return c.json({ error: 'Cross-site request refused.' }, 403);
      }
    }
    return next();
  };

  /** Every API route except health and sign-in needs a full session. */
  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = auth.getSession(token);
    if (!session || session.stage !== 'full') return c.json({ error: 'Sign in required.' }, 401);
    c.set('session', session);
    c.set('token', token!);
    return next();
  };

  const routes = new Hono<Env>();

  routes.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Something went wrong.' }, 500);
  });

  routes.get('/state', (c) => {
    const session = auth.getSession(getCookie(c, SESSION_COOKIE));
    return c.json({
      setupRequired: !auth.hasUsers(),
      stage: session?.stage ?? null,
      user: session ? { username: session.user.username } : null,
      role: session?.stage === 'full' ? session.user.role : null,
      permissions: session?.stage === 'full' ? permissionsFor(session.user.role) : [],
      recoveryCodesLeft: session?.stage === 'full' ? auth.recoveryCodesLeft(session.user.id) : null,
    });
  });

  routes.post('/setup', async (c) => {
    checkLimits(c);
    const { setupCode, username, password } = await body<{ setupCode: string; username: string; password: string }>(c);
    try {
      const token = await auth.setup(str(setupCode), str(username), str(password), client(c));
      setSessionCookie(c, token, false);
      return c.json({ next: 'enroll' });
    } catch (err) {
      if (err instanceof AuthError && err.status === 403) recordFailure(c);
      throw err;
    }
  });

  routes.post('/login', async (c) => {
    const { username, password } = await body<{ username: string; password: string }>(c);
    checkLimits(c, str(username));
    try {
      const { token, stage } = await auth.login(str(username), str(password), client(c));
      setSessionCookie(c, token, false);
      return c.json({ next: stage });
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) recordFailure(c, str(username));
      throw err;
    }
  });

  routes.get('/enroll', async (c) => {
    const token = getCookie(c, SESSION_COOKIE) ?? '';
    const secret = auth.enrollmentSecret(token);
    const session = auth.getSession(token)!;
    const url = otpauthUrl(secret, session.user.username);
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    c.header('Cache-Control', 'no-store');
    return c.json({ secret, otpauthUrl: url, qrSvg });
  });

  routes.post('/enroll', async (c) => {
    checkLimits(c);
    const { code } = await body<{ code: string }>(c);
    try {
      const result = auth.confirmEnrollment(getCookie(c, SESSION_COOKIE) ?? '', str(code), client(c));
      setSessionCookie(c, result.token, true);
      c.header('Cache-Control', 'no-store');
      return c.json({ recoveryCodes: result.recoveryCodes });
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) recordFailure(c);
      throw err;
    }
  });

  routes.post('/verify', async (c) => {
    checkLimits(c);
    const { code, recoveryCode } = await body<{ code: string; recoveryCode: string }>(c);
    try {
      const result = auth.verifySecondFactor(getCookie(c, SESSION_COOKIE) ?? '', { code: str(code), recoveryCode: str(recoveryCode) }, client(c));
      setSessionCookie(c, result.token, true);
      return c.json({ ok: true, usedRecoveryCode: result.usedRecoveryCode });
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) recordFailure(c);
      throw err;
    }
  });

  routes.post('/logout', (c) => {
    auth.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Account settings: signed in only.
  routes.use('/account/*', requireSession);

  routes.get('/account/sessions', (c) => {
    const session = c.get('session');
    return c.json({ sessions: auth.sessions(session.user.id, session.publicId) });
  });

  routes.delete('/account/sessions/:id', (c) => {
    auth.revokeSession(c.get('session').user.id, c.req.param('id'));
    return c.json({ ok: true });
  });

  routes.post('/account/password', async (c) => {
    checkLimits(c);
    const { currentPassword, newPassword, code } = await body<{ currentPassword: string; newPassword: string; code: string }>(c);
    const session = c.get('session');
    try {
      await auth.changePassword(session.user.id, session.publicId, str(currentPassword), str(newPassword), str(code));
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) recordFailure(c);
      throw err;
    }
  });

  routes.post('/account/recovery-codes', async (c) => {
    checkLimits(c);
    const { code } = await body<{ code: string }>(c);
    try {
      const codes = auth.regenerateRecoveryCodes(c.get('session').user.id, str(code));
      c.header('Cache-Control', 'no-store');
      return c.json({ recoveryCodes: codes });
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) recordFailure(c);
      throw err;
    }
  });

  // Managing accounts: admins only, and each change needs the admin's own 2FA code.
  routes.use('/accounts/*', requireSession, requirePermission('manageAccounts'));
  routes.use('/accounts', requireSession, requirePermission('manageAccounts'));

  routes.get('/accounts', (c) => c.json({ accounts: auth.accounts(), currentId: c.get('session').user.id }));

  const confirmed = async (c: Context<Env>) => {
    checkLimits(c);
    const input = await body<{ code: string; username: string; password: string; role: string }>(c);
    try {
      auth.confirmWithCode(c.get('session').user.id, str(input.code));
    } catch (err) {
      if (err instanceof AuthError && err.status === 401) recordFailure(c);
      throw err;
    }
    return input;
  };
  const targetId = (c: Context<Env>) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) throw new AuthError('No such account.', 404);
    return id;
  };

  routes.post('/accounts', async (c) => {
    const { username, password, role } = await confirmed(c);
    if (!isRole(role)) throw new AuthError('Choose a role.');
    const account = await auth.addAccount(str(username), str(password), role);
    return c.json({ account }, 201);
  });

  routes.post('/accounts/:id/role', async (c) => {
    const { role } = await confirmed(c);
    if (!isRole(role)) throw new AuthError('Choose a role.');
    auth.setRole(c.get('session').user.id, targetId(c), role);
    return c.json({ ok: true });
  });

  routes.post('/accounts/:id/reset-2fa', async (c) => {
    await confirmed(c);
    auth.resetTwoFactorById(targetId(c));
    return c.json({ ok: true });
  });

  routes.post('/accounts/:id/password', async (c) => {
    const { password } = await confirmed(c);
    await auth.resetPasswordById(targetId(c), str(password));
    return c.json({ ok: true });
  });

  routes.post('/accounts/:id/delete', async (c) => {
    await confirmed(c);
    auth.deleteAccount(c.get('session').user.id, targetId(c));
    return c.json({ ok: true });
  });

  return { routes, csrf, requireSession };
}
