import { randomBytes } from 'node:crypto';
import { isRole, type Role } from '../../shared/permissions.js';
import { type Database, transaction } from '../db/database.js';
import {
  dummyPasswordHash,
  generateRecoveryCode,
  hashPassword,
  normalizeRecoveryCode,
  passwordProblem,
  randomToken,
  sha256,
  verifyPassword,
} from './password.js';
import { currentStep, generateSecret, verifyCode } from './totp.js';

export type SessionStage = 'totp' | 'enroll' | 'full';

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
  totpEnabled: boolean;
}

export interface AccountInfo {
  id: number;
  username: string;
  role: Role;
  totpEnabled: boolean;
  createdAt: string;
  /** Most recent activity of any of the account's sessions. */
  lastSeenAt: string | null;
}

export interface Session {
  publicId: string;
  stage: SessionStage;
  user: AuthUser;
  pendingSecret: string | null;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

/** A pending sign-in (waiting for a 2FA code) lasts this long. */
const PENDING_MS = 10 * 60 * 1000;
/** A full session lasts at most this long… */
const SESSION_MAX_MS = 30 * 86_400_000;
/** …and ends sooner if unused for this long. */
const SESSION_IDLE_MS = 7 * 86_400_000;
/** Wrong 2FA codes allowed on one pending sign-in before the password is needed again. */
const MAX_CODE_FAILURES = 5;
const RECOVERY_CODE_COUNT = 10;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;

interface UserRow {
  id: number;
  role: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
}

interface SessionRow {
  token_hash: string;
  public_id: string;
  user_id: number;
  stage: SessionStage;
  pending_secret: string | null;
  failed_codes: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export class AuthService {
  /**
   * Needed to create the first account through the web page, so whoever
   * finds a fresh install first can't claim it. Printed in the server log.
   */
  readonly setupCode: string;

  constructor(private readonly db: Database) {
    this.setupCode = randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
    void dummyPasswordHash(); // warm up, so the first failed login isn't faster
  }

  hasUsers(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM auth_users').get() as { n: number }).n > 0;
  }

  async createUser(username: string, password: string, role: Role = 'admin'): Promise<AuthUser> {
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new AuthError('Usernames are 3–32 characters: letters, numbers, dots, dashes and underscores.');
    }
    const problem = passwordProblem(password, name);
    if (problem) throw new AuthError(problem);
    if (this.findUser(name)) throw new AuthError('That username is taken.', 409);

    const now = new Date().toISOString();
    const hash = await hashPassword(password);
    const result = this.db
      .prepare('INSERT INTO auth_users (username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, hash, role, now, now);
    return { id: Number(result.lastInsertRowid), username: name, role, totpEnabled: false };
  }

  /** First-run setup from the web page. Returns a session that must set up 2FA next. */
  async setup(setupCode: string, username: string, password: string, client: ClientInfo): Promise<string> {
    if (this.hasUsers()) throw new AuthError('Almanac is already set up. Sign in instead.', 409);
    const given = setupCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (given !== this.setupCode.replace(/-/g, '')) throw new AuthError('That setup code is wrong. Find it in Almanac’s log.', 403);
    const user = await this.createUser(username, password);
    return this.createSession(user.id, 'enroll', client);
  }

  /** Check a username and password. Returns a pending session and what comes next. */
  async login(username: string, password: string, client: ClientInfo): Promise<{ token: string; stage: SessionStage }> {
    const user = this.findUser(username.trim());
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) throw new AuthError('Wrong username or password.', 401);
    const stage: SessionStage = user.totp_enabled ? 'totp' : 'enroll';
    return { token: this.createSession(user.id, stage, client), stage };
  }

  /** Look up a session from its cookie token. Expired sessions are deleted. */
  getSession(token: string | undefined): Session | null {
    if (!token) return null;
    const hash = sha256(token);
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(hash) as SessionRow | undefined;
    if (!row) return null;

    const now = Date.now();
    const idle = row.stage === 'full' && now - Date.parse(row.last_seen_at) > SESSION_IDLE_MS;
    if (now > Date.parse(row.expires_at) || idle) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    // Record activity, at most once a minute.
    if (now - Date.parse(row.last_seen_at) > 60_000) {
      this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), hash);
    }

    const user = this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(row.user_id) as UserRow | undefined;
    if (!user) return null;
    return {
      publicId: row.public_id,
      stage: row.stage,
      pendingSecret: row.pending_secret,
      user: { id: user.id, username: user.username, role: roleOf(user), totpEnabled: user.totp_enabled === 1 },
    };
  }

  /** The secret to show as a QR code while setting up 2FA. Stays the same until confirmed. */
  enrollmentSecret(token: string): string {
    const session = this.requireStage(token, 'enroll');
    if (session.pendingSecret) return session.pendingSecret;
    const secret = generateSecret();
    this.db.prepare('UPDATE auth_sessions SET pending_secret = ? WHERE token_hash = ?').run(secret, sha256(token));
    return secret;
  }

  /**
   * Confirm 2FA setup with a code from the app. Turns 2FA on, creates recovery
   * codes, and swaps the pending session for a full one with a new token.
   */
  confirmEnrollment(token: string, code: string, client: ClientInfo): { token: string; recoveryCodes: string[] } {
    const session = this.requireStage(token, 'enroll');
    if (!session.pendingSecret) throw new AuthError('Start 2FA setup first.', 409);
    const step = verifyCode(session.pendingSecret, code, null);
    if (step == null) {
      this.countFailure(token);
      throw new AuthError('That code didn’t match. Check your phone’s clock is right and try the newest code.', 401);
    }

    return transaction(this.db, () => {
      this.db
        .prepare('UPDATE auth_users SET totp_secret = ?, totp_enabled = 1, totp_last_step = ? WHERE id = ?')
        .run(session.pendingSecret, step, session.user.id);
      const recoveryCodes = this.replaceRecoveryCodes(session.user.id);
      return { token: this.upgrade(token, session.user.id, client), recoveryCodes };
    });
  }

  /** Finish signing in with a code from the app or a recovery code. */
  verifySecondFactor(token: string, input: { code?: string; recoveryCode?: string }, client: ClientInfo): { token: string; usedRecoveryCode: boolean } {
    const session = this.requireStage(token, 'totp');
    const user = this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(session.user.id) as unknown as UserRow;

    if (input.recoveryCode) {
      const hash = sha256(normalizeRecoveryCode(input.recoveryCode));
      const result = this.db
        .prepare('UPDATE auth_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .run(new Date().toISOString(), user.id, hash);
      if (result.changes !== 1) {
        this.countFailure(token);
        throw new AuthError('That recovery code isn’t valid or has already been used.', 401);
      }
      return { token: this.upgrade(token, user.id, client), usedRecoveryCode: true };
    }

    const step = user.totp_secret ? verifyCode(user.totp_secret, input.code ?? '', user.totp_last_step) : null;
    if (step == null) {
      this.countFailure(token);
      throw new AuthError('That code didn’t match. Codes change every 30 seconds and each one works once.', 401);
    }
    this.db.prepare('UPDATE auth_users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    return { token: this.upgrade(token, user.id, client), usedRecoveryCode: false };
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
  }

  sessions(userId: number, currentPublicId: string): SessionInfo[] {
    const rows = this.db
      .prepare("SELECT * FROM auth_sessions WHERE user_id = ? AND stage = 'full' ORDER BY last_seen_at DESC")
      .all(userId) as unknown as (SessionRow & { ip: string | null; user_agent: string | null })[];
    return rows.map((r) => ({
      id: r.public_id,
      current: r.public_id === currentPublicId,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      ip: r.ip,
      userAgent: r.user_agent,
    }));
  }

  revokeSession(userId: number, publicId: string): void {
    const result = this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND public_id = ?').run(userId, publicId);
    if (result.changes === 0) throw new AuthError('No such session.', 404);
  }

  /** Change password. Needs the current password and a 2FA code; signs out every other session. */
  async changePassword(userId: number, currentPublicId: string, current: string, next: string, code: string): Promise<void> {
    const user = this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId) as unknown as UserRow;
    if (!(await verifyPassword(current, user.password_hash))) throw new AuthError('Your current password is wrong.', 401);
    this.checkCode(user, code);
    const problem = passwordProblem(next, user.username);
    if (problem) throw new AuthError(problem);
    const hash = await hashPassword(next);
    transaction(this.db, () => {
      this.db.prepare('UPDATE auth_users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, new Date().toISOString(), userId);
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND public_id <> ?').run(userId, currentPublicId);
    });
  }

  /** New recovery codes (the old ones stop working). Needs a current 2FA code. */
  regenerateRecoveryCodes(userId: number, code: string): string[] {
    const user = this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId) as unknown as UserRow;
    this.checkCode(user, code);
    return transaction(this.db, () => this.replaceRecoveryCodes(userId));
  }

  recoveryCodesLeft(userId: number): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM auth_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { n: number }
    ).n;
  }

  // ----- Account management (admins) -----

  accounts(): AccountInfo[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.role, u.totp_enabled, u.created_at,
                (SELECT MAX(last_seen_at) FROM auth_sessions s WHERE s.user_id = u.id AND s.stage = 'full') AS last_seen_at
         FROM auth_users u ORDER BY u.username COLLATE NOCASE`,
      )
      .all() as { id: number; username: string; role: string; totp_enabled: number; created_at: string; last_seen_at: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: isRole(r.role) ? r.role : 'mod',
      totpEnabled: r.totp_enabled === 1,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  /** Confirm the acting admin's identity with a fresh 2FA code before an account change. */
  confirmWithCode(userId: number, code: string): void {
    const user = this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId) as unknown as UserRow;
    this.checkCode(user, code);
  }

  async addAccount(username: string, password: string, role: Role): Promise<AccountInfo> {
    const user = await this.createUser(username, password, role);
    return this.accounts().find((a) => a.id === user.id)!;
  }

  setRole(actingUserId: number, targetId: number, role: Role): void {
    const target = this.requireAccount(targetId);
    // Admins may change their own role too, as long as another admin remains.
    void actingUserId;
    if (roleOf(target) === 'admin' && role !== 'admin') this.ensureAnotherAdmin(targetId, 'demote');
    this.db.prepare('UPDATE auth_users SET role = ? WHERE id = ?').run(role, targetId);
  }

  deleteAccount(actingUserId: number, targetId: number): void {
    const target = this.requireAccount(targetId);
    if (targetId === actingUserId) throw new AuthError('You can’t delete your own account. Ask another admin.', 409);
    if (roleOf(target) === 'admin') this.ensureAnotherAdmin(targetId, 'delete');
    // Sessions and recovery codes go with it (ON DELETE CASCADE).
    this.db.prepare('DELETE FROM auth_users WHERE id = ?').run(targetId);
  }

  resetTwoFactorById(targetId: number): void {
    this.resetTwoFactor(this.requireAccount(targetId).username);
  }

  async resetPasswordById(targetId: number, password: string): Promise<void> {
    await this.resetPassword(this.requireAccount(targetId).username, password);
  }

  private requireAccount(id: number): UserRow {
    const user = this.db.prepare('SELECT * FROM auth_users WHERE id = ?').get(id) as unknown as UserRow | undefined;
    if (!user) throw new AuthError('No such account.', 404);
    return user;
  }

  /** There must always be at least one admin, or nobody could manage accounts. */
  private ensureAnotherAdmin(exceptId: number, action: 'demote' | 'delete'): void {
    const others = (
      this.db.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE role = 'admin' AND id <> ?").get(exceptId) as { n: number }
    ).n;
    if (others === 0) {
      throw new AuthError(`You can’t ${action} the only admin. Make someone else an admin first.`, 409);
    }
  }

  // ----- For the command-line recovery tool -----

  /** Turn off 2FA for an account and sign it out everywhere; it sets 2FA up again at next sign-in. */
  resetTwoFactor(username: string): void {
    const user = this.findUser(username);
    if (!user) throw new AuthError(`No account called ${username}.`, 404);
    transaction(this.db, () => {
      this.db.prepare('UPDATE auth_users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?').run(user.id);
      this.db.prepare('DELETE FROM auth_recovery_codes WHERE user_id = ?').run(user.id);
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
    });
  }

  async resetPassword(username: string, password: string): Promise<void> {
    const user = this.findUser(username);
    if (!user) throw new AuthError(`No account called ${username}.`, 404);
    const problem = passwordProblem(password, user.username);
    if (problem) throw new AuthError(problem);
    const hash = await hashPassword(password);
    transaction(this.db, () => {
      this.db.prepare('UPDATE auth_users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, new Date().toISOString(), user.id);
      this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
    });
  }

  listUsernames(): { username: string; role: Role; totpEnabled: boolean }[] {
    return this.accounts().map((a) => ({ username: a.username, role: a.role, totpEnabled: a.totpEnabled }));
  }

  /** For the CLI: change a role by username, e.g. to recover admin access. */
  setRoleByName(username: string, role: Role): void {
    const user = this.findUser(username);
    if (!user) throw new AuthError(`No account called ${username}.`, 404);
    if (roleOf(user) === 'admin' && role !== 'admin') this.ensureAnotherAdmin(user.id, 'demote');
    this.db.prepare('UPDATE auth_users SET role = ? WHERE id = ?').run(role, user.id);
  }

  // ----- Internals -----

  private findUser(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM auth_users WHERE username = ?').get(username) as UserRow | undefined;
  }

  private createSession(userId: number, stage: SessionStage, client: ClientInfo): string {
    const token = randomToken();
    const now = new Date();
    const expires = new Date(now.getTime() + (stage === 'full' ? SESSION_MAX_MS : PENDING_MS));
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, public_id, user_id, stage, created_at, last_seen_at, expires_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(token), randomBytes(9).toString('base64url'), userId, stage, now.toISOString(), now.toISOString(), expires.toISOString(), client.ip, client.userAgent?.slice(0, 300) ?? null);
    // Tidy up: drop expired sessions now and then.
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now.toISOString());
    return token;
  }

  /** Replace a pending session with a full one under a new token. */
  private upgrade(token: string, userId: number, client: ClientInfo): string {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
    return this.createSession(userId, 'full', client);
  }

  private requireStage(token: string, stage: SessionStage): Session {
    const session = this.getSession(token);
    if (!session) throw new AuthError('Your sign-in has expired. Start again.', 401);
    if (session.stage !== stage) throw new AuthError('That step isn’t available right now.', 409);
    return session;
  }

  private countFailure(token: string): void {
    const hash = sha256(token);
    this.db.prepare('UPDATE auth_sessions SET failed_codes = failed_codes + 1 WHERE token_hash = ?').run(hash);
    const row = this.db.prepare('SELECT failed_codes FROM auth_sessions WHERE token_hash = ?').get(hash) as { failed_codes: number } | undefined;
    if (row && row.failed_codes >= MAX_CODE_FAILURES) {
      this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash);
      throw new AuthError('Too many wrong codes. Sign in with your password again.', 401);
    }
  }

  private checkCode(user: UserRow, code: string): void {
    const step = user.totp_secret ? verifyCode(user.totp_secret, code, user.totp_last_step) : null;
    if (step == null) throw new AuthError('That 2FA code didn’t match.', 401);
    this.db.prepare('UPDATE auth_users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  }

  private replaceRecoveryCodes(userId: number): string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    this.db.prepare('DELETE FROM auth_recovery_codes WHERE user_id = ?').run(userId);
    const insert = this.db.prepare('INSERT INTO auth_recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const code of codes) insert.run(userId, sha256(normalizeRecoveryCode(code)));
    return codes;
  }
}

function roleOf(user: { role: string }): Role {
  // Unknown values get the least access.
  return isRole(user.role) ? user.role : 'mod';
}

export { currentStep };
