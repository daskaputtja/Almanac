import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { CatalogSync } from '../server/library/sync.js';
import { MockCatalogSource, MockHistorySource } from '../server/silo/mock.js';
import { UsersService } from '../server/users/users.js';

async function setup() {
  const db = openDatabase(':memory:');
  const sync = new CatalogSync(db, new MockCatalogSource(), { intervalMs: 60_000, log: () => {} });
  await sync.syncUsers();
  const plays = (await new MockHistorySource(Date.now(), 300).listHistoryPage({ limit: 300 })).items;
  new HistoryStore(db).upsert(plays);
  return { users: new UsersService(db), plays };
}

describe('UsersService', () => {
  it('combines Silo accounts with play totals', async () => {
    const { users, plays } = await setup();
    const list = users.list();
    // "quill" has an account but no plays.
    const quill = list.find((u) => u.name === 'quill')!;
    expect(quill.plays).toBe(0);
    expect(quill.enabled).toBe(false);
    expect(quill.lastPlayedAt).toBeNull();

    const counted = plays.filter((p) => p.played_seconds == null || p.played_seconds >= 30);
    expect(list.reduce((sum, u) => sum + u.plays, 0)).toBe(counted.length);
    const owner = list.find((u) => u.isOwner)!;
    expect(owner.role).toBe('admin');
  });

  it('lists a user’s players, addresses and profiles', async () => {
    const { users } = await setup();
    const someone = users.list().find((u) => u.plays > 0)!;
    const detail = users.get(someone.id)!;
    expect(detail.devices.reduce((sum, d) => sum + d.plays, 0)).toBe(someone.plays);
    expect(detail.addresses.length).toBeGreaterThan(0);
    expect(detail.profiles[0]!.name).toBe('Main');
    expect(detail.firstPlayedAt).not.toBeNull();
  });

  it('returns null for an unknown user', async () => {
    const { users } = await setup();
    expect(users.get('nobody')).toBeNull();
  });
});
