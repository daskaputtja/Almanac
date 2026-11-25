import { describe, expect, it } from 'vitest';
import { AuthService } from '../server/auth/service.js';
import { openDatabase } from '../server/db/database.js';
import { EXPO_PUSH_URL, PushService } from '../server/push/push.js';

const FLAG = {
  reason: 'new' as const,
  userId: '7',
  username: 'pike',
  email: 'pike@example.com',
  kind: 'concurrent_networks' as const,
  severity: 'high' as const,
  headline: 'Streamed from 4 different networks at the same time',
  details: [],
};

async function setup() {
  const db = openDatabase(':memory:');
  const auth = new AuthService(db);
  const admin = await auth.addAccount('sam', 'a long passphrase here', 'admin');
  const mod = await auth.addAccount('morgan', 'another long passphrase', 'mod');
  const signIn = (userId: number, id: string) =>
    db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, public_id, user_id, stage, created_at, last_seen_at, expires_at, client_kind)
         VALUES (?, ?, ?, 'full', ?, ?, ?, 'app')`,
      )
      .run(`hash-${id}`, id, userId, new Date().toISOString(), new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  signIn(admin.id, 'admin-phone');
  signIn(mod.id, 'mod-phone');

  const sent: { to: string; title: string; body: string; data: { path?: string } }[] = [];
  const unregistered = new Set<string>();
  const push = new PushService(
    db,
    async (url, init) => {
      expect(url).toBe(EXPO_PUSH_URL);
      const messages = JSON.parse(String(init?.body)) as typeof sent;
      sent.push(...messages);
      return new Response(
        JSON.stringify({ data: messages.map((m) => (unregistered.has(m.to) ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' })) }),
        { status: 200 },
      );
    },
    () => {},
  );
  push.register('admin-phone', admin.id, { pushToken: 'ExponentPushToken[admin-aaaaaaaaaa]', platform: 'ios' });
  push.register('mod-phone', mod.id, { pushToken: 'ExponentPushToken[mod-bbbbbbbbbbbb]', platform: 'android' });
  return { db, push, sent, unregistered };
}

describe('push notifications', () => {
  it('sends new flags to everyone who moderates, with a link to the account', async () => {
    const { push, sent } = await setup();
    await push.flagEvents([FLAG]);
    expect(sent.map((m) => m.to).sort()).toEqual(['ExponentPushToken[admin-aaaaaaaaaa]', 'ExponentPushToken[mod-bbbbbbbbbbbb]']);
    expect(sent[0]).toMatchObject({ title: 'Serious · Possible account sharing', body: 'pike: Streamed from 4 different networks at the same time', data: { path: '/users/7' } });
  });

  it('follows each phone’s settings, including hiding details', async () => {
    const { push, sent } = await setup();
    push.setPreferences('mod-phone', { flags: 'off' });
    push.setPreferences('admin-phone', { details: false });
    await push.flagEvents([FLAG]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: 'New account flag', body: 'Serious. Open Almanac to see it.' });
    expect(JSON.stringify(sent[0])).not.toContain('pike');
  });

  it('asks admins, not mods, to review suspension requests, and tells the mod the outcome', async () => {
    const { push, sent } = await setup();
    await push.suspensionRequested({ userId: '7', username: 'pike', action: 'suspend', requestedBy: 'morgan' });
    expect(sent.map((m) => m.to)).toEqual(['ExponentPushToken[admin-aaaaaaaaaa]']);
    await push.suspensionDecided({ userId: '7', username: 'pike', action: 'suspend', requestedBy: 'morgan', status: 'done', reviewedBy: 'sam' });
    expect(sent[1]).toMatchObject({ to: 'ExponentPushToken[mod-bbbbbbbbbbbb]', title: 'Request approved' });
  });

  it('forgets phones that uninstalled the app, and phones that were signed out', async () => {
    const { db, push, sent, unregistered } = await setup();
    unregistered.add('ExponentPushToken[mod-bbbbbbbbbbbb]');
    await push.serverAlert({ title: 'Emby 3 is down', body: 'Uptime Kuma says it isn’t answering.' });
    expect(push.preferences('mod-phone')).toBeNull();

    db.prepare("DELETE FROM auth_sessions WHERE public_id = 'admin-phone'").run(); // signed out in Settings
    sent.length = 0;
    await push.serverAlert({ title: 'Emby 3 is back up', body: '' });
    expect(sent).toHaveLength(0);
  });

  it('only accepts Expo push tokens', async () => {
    const { push } = await setup();
    expect(() => push.register('admin-phone', 1, { pushToken: 'https://evil.example' })).toThrow(/Expo push token/);
  });
});
