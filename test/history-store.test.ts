import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { MockHistorySource } from '../server/silo/mock.js';
import type { SiloHistoryEntry } from '../server/silo/types.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');

async function demoEntries(count = 120): Promise<SiloHistoryEntry[]> {
  const page = await new MockHistorySource(NOW, count).listHistoryPage({ limit: count });
  return page.items;
}

describe('HistoryStore', () => {
  let store: HistoryStore;
  let entries: SiloHistoryEntry[];

  beforeEach(async () => {
    store = new HistoryStore(openDatabase(':memory:'));
    entries = await demoEntries();
    store.upsert(entries);
  });

  it('stores and pages plays newest first', () => {
    const page = store.query({ pageSize: 10 });
    expect(page.total).toBe(entries.length);
    expect(page.items).toHaveLength(10);
    expect(page.items[0]!.id).toBe(entries[0]!.session_id);
    const endTimes = page.items.map((e) => e.endedAt);
    expect([...endTimes].sort().reverse()).toEqual(endTimes);

    const page2 = store.query({ pageSize: 10, page: 2 });
    expect(page2.items[0]!.id).toBe(entries[10]!.session_id);
  });

  it('is idempotent when the same plays arrive again', () => {
    store.upsert(entries);
    expect(store.stats().total).toBe(entries.length);
  });

  it('keeps names Silo later blanks out because a user or item was deleted', () => {
    const original = entries[0]!;
    store.upsert([{ ...original, username: '', media_title: '', series_title: '', lifecycle_seq: (original.lifecycle_seq ?? 0) + 1 }]);
    const [stored] = store.query({ pageSize: 1 }).items;
    expect(stored!.user.name).toBe(original.username);
    expect(stored!.media.title).toBe(original.media_title);
  });

  it('ignores an older version of a play', () => {
    const original = entries[0]!;
    store.upsert([{ ...original, end_reason: 'aborted', lifecycle_seq: (original.lifecycle_seq ?? 0) - 1 }]);
    expect(store.query({ pageSize: 1 }).items[0]!.endReason).toBe(original.end_reason);
  });

  it('filters by user, type, method, platform and date', () => {
    const target = entries[5]!;
    const byUser = store.query({ userId: target.user_id, pageSize: 100 });
    expect(byUser.total).toBe(entries.filter((e) => e.user_id === target.user_id).length);
    expect(byUser.items.every((e) => e.user.id === target.user_id)).toBe(true);

    expect(store.query({ mediaType: 'movie' }).total).toBe(entries.filter((e) => e.media_type === 'movie').length);
    expect(store.query({ method: 'transcode' }).total).toBe(entries.filter((e) => e.play_method === 'transcode').length);
    expect(store.query({ platform: 'ios' }).total).toBe(entries.filter((e) => e.device_platform === 'ios').length);

    const from = new Date(NOW - 7 * 86_400_000).toISOString();
    expect(store.query({ from }).total).toBe(entries.filter((e) => e.ended_at >= from).length);
  });

  it('hides short plays but keeps unmeasured ones', () => {
    const short = { ...entries[0]!, session_id: 'short', played_seconds: 5, measured: true };
    const unmeasured = { ...entries[0]!, session_id: 'unmeasured', played_seconds: null, measured: false };
    store.upsert([short, unmeasured]);
    const ids = store.query({ minWatchedSeconds: 30, pageSize: 100, search: entries[0]!.media_title }).items.map((e) => e.id);
    expect(ids).not.toContain('short');
    expect(ids).toContain('unmeasured');
  });

  it('searches titles, users and IPs, treating % and _ literally', () => {
    const target = entries[3]!;
    expect(store.query({ search: target.username.toUpperCase() }).total).toBeGreaterThan(0);
    expect(store.query({ search: target.client_ip! }).items.some((e) => e.client.ip === target.client_ip)).toBe(true);
    expect(store.query({ search: '%' }).total).toBe(0);
    expect(store.query({ search: '_' }).total).toBe(0);
  });

  it('sorts by watched time', () => {
    const asc = store.query({ sort: 'watched', direction: 'asc', pageSize: 100 }).items.map((e) => e.watchedSeconds ?? 0);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
  });

  it('lists users and platforms for the filters', () => {
    const options = store.filterOptions();
    expect(options.users.reduce((sum, u) => sum + u.plays, 0)).toBe(entries.length);
    expect(options.platforms.length).toBeGreaterThan(0);
  });

  it('keeps sync state', () => {
    expect(store.getState('x')).toBeNull();
    store.setState('x', 'one');
    store.setState('x', 'two');
    expect(store.getState('x')).toBe('two');
  });
});
