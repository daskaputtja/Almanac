import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/** scrypt settings: about 50–100 ms per hash on a typical server. */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Hash a password as `scrypt$N$r$p$salt$hash`, so the settings can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Hashed once at startup and checked against for unknown usernames, so they take as long as real ones. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

/** A readable reason a new password isn't good enough, or null if it's fine. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 512) return 'That password is too long.';
  if (password.toLowerCase().includes(username.toLowerCase()) && username.length >= 3) {
    return 'Don’t include your username in your password.';
  }
  if (new Set(password).size < 5) return 'Use a password with more variety.';
  return null;
}

/** SHA-256 of a high-entropy value (session tokens, recovery codes). These don't need a slow hash. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A random token for cookies: 32 bytes, URL-safe. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i/l/1, o/0)

/** A recovery code such as `k7mq-x2tf-9wcd` (about 70 bits). */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** Recovery codes are compared without dashes, spaces or case. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}
