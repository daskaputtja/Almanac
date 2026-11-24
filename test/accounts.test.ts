import { describe, expect, it } from 'vitest';
import { AccountsService } from '../server/accounts/accounts.js';
import { openDatabase } from '../server/db/database.js';
import { ModerationService } from '../server/moderation/service.js';
import { StaffAlerts } from '../server/notify/staff.js';
import { ALERT_MIN_PLAYS, ReliabilityService } from '../server/reliability/reliability.js';
import { MockAccountSource, MockServerSource } from '../server/silo/mock.js';
import type { AccountSource } from '../server/silo/client.js';
import type { SiloDevice, SiloDownload } from '../server/silo/types.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function download(id: string, userId: string, hoursAgo: number, sizeGb = 2): SiloDownload {
  return {
    id,
    user_id: userId,
    username: `user${userId}`,
    device_name: 'Pixel 9',
    title: `Movie ${id}`,
    media_type: 'movie',
    status: 'completed',
    quality: 'original',
    file_size: sizeGb * 1e9,
    created_at: ago(hoursAgo),
    created_client_ip: '198.51.100.7',
  };
}

class FakeAccounts implements AccountSource {
  downloads: SiloDownload[] = [];
  devices: SiloDevice[] = [];
  async listDownloads() {
    return this.downloads;
  }
  async listDevices() {
    return this.devices;
  }
}

describe('offline downloads and devices', () => {
  it('keeps downloads Silo has forgotten, and hides addresses from mods', async () => {
    const db = openDatabase(':memory:');
    const source = new FakeAccounts();
    const accounts = new AccountsService(db, source, () => {});
    source.downloads = [download('a', '7', 2), download('b', '7', 30), download('c', '8', 24 * 40)];
    await accounts.sync(NOW);
    source.downloads = [download('a', '7', 2)]; // b and c deleted from the devices
    await accounts.sync(NOW + 60_000);

    const admin = accounts.overview(true, NOW);
    expect(admin.totals).toMatchObject({ onDevices: 1, last7Days: 2, last30Days: 2, accountsWithDownloads: 1 });
    expect(admin.recent.map((d) => [d.id, d.present])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
    expect(admin.recent[0]!.ip).toBe('198.51.100.7');
    expect(accounts.overview(false, NOW).recent.every((d) => d.ip === null)).toBe(true);
    expect(accounts.forUser('7', false, NOW)).toMatchObject({ last30Days: 2, total: 2, onDevices: 1 });
  });

  it('flags heavy downloading and lots of signed-in devices', async () => {
    const db = openDatabase(':memory:');
    const source = new FakeAccounts();
    const accounts = new AccountsService(db, source, () => {});
    // 45 downloads in 3 days: over the 40 "worth a look" level.
    source.downloads = Array.from({ length: 45 }, (_, i) => download(`d${i}`, '7', i * 1.5));
    // 26 devices used this month: over the 25 "worth a look" level. Old devices don't count.
    source.devices = Array.from({ length: 30 }, (_, i) => ({
      user_id: '9',
      device_id: `dev${i}`,
      device_name: `TV ${i}`,
      device_platform: i % 2 ? 'android-tv' : 'iOS',
      last_updated: ago(i < 26 ? 24 : 24 * 60),
    }));
    await accounts.sync(NOW);
    const moderation = new ModerationService(db);
    moderation.refresh(new Map(), NOW);
    const flags = moderation.flags({ status: 'all', includeAdminDetails: true }).flags;
    expect(flags.find((f) => f.userId === '7')).toMatchObject({ kind: 'heavy_downloads', severity: 'medium', group: 'ripping' });
    expect(flags.find((f) => f.userId === '7')!.headline).toBe('Downloaded 45 titles (90 GB) for offline viewing in 7 days');
    expect(flags.find((f) => f.userId === '9')).toMatchObject({ kind: 'many_registered_devices', severity: 'medium', group: 'sharing' });
  });

  it('works with the demo data', async () => {
    const db = openDatabase(':memory:');
    const accounts = new AccountsService(db, new MockAccountSource(), () => {});
    await accounts.sync();
    expect(accounts.overview(true).totals.last30Days).toBeGreaterThan(40);
    expect(accounts.devicesForUser('103')).toHaveLength(17);
  });
});

describe('reliability', () => {
  function setup() {
    const db = openDatabase(':memory:');
    const insert = db.prepare(
      `INSERT INTO plays (session_id, user_id, username, profile_id, media_type, title, started_at, ended_at, end_position,
         watched_seconds, completed, play_method, client_name, device_platform, end_reason, imported_at)
       VALUES (?, '1', 'u', 'p', 'movie', 'T', ?, ?, 0, ?, 0, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    const play = (endedHoursAgo: number, opts: { dropped?: boolean; watched?: number; player?: string; method?: string } = {}) =>
      insert.run(
        `s${++n}`,
        ago(endedHoursAgo + 0.5),
        ago(endedHoursAgo),
        opts.watched ?? 1200,
        opts.method ?? 'direct',
        opts.player ?? 'Silo for Android TV',
        'android-tv',
        opts.dropped ? 'expired' : 'stopped',
        ago(0),
      );
    const posts: { embeds: { title: string; description: string }[] }[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    };
    const staff = new StaffAlerts(db, fetchImpl, () => {});
    staff.update({ webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123' }, 'admin');
    const reliability = new ReliabilityService(db, new MockServerSource(), staff, () => {});
    return { db, play, posts, staff, reliability };
  }

  it('reports drops and quick stops, by player and method', async () => {
    const { play, reliability } = setup();
    for (let i = 0; i < 20; i++) play(2 + i * 0.1, { dropped: i < 4, watched: i >= 18 ? 4 : 1200, player: i % 2 ? 'Silo for iOS' : 'Silo for Android TV' });
    const report = await reliability.report('24h', NOW);
    expect(report.totals).toEqual({ plays: 20, dropped: 4, quickStops: 2 });
    expect(report.players.reduce((sum, p) => sum + p.plays, 0)).toBe(20);
    expect(report.methods).toHaveLength(1);
    expect(report.buckets.reduce((sum, b) => sum + b[1], 0)).toBe(20);
    expect(report.silo?.sessionsStarted).toBeGreaterThan(0);
  });

  it('alerts staff when streams drop far more than usual, then says when it’s over', async () => {
    const { play, posts, reliability } = setup();
    // Two weeks of normal days: about 5% dropped around this hour.
    for (let d = 1; d <= 14; d++) for (let i = 0; i < 40; i++) play(d * 24 + i / 40 - 0.5, { dropped: i % 20 === 0 });
    // The last hour: 30% dropped.
    for (let i = 0; i < ALERT_MIN_PLAYS; i++) play(0.5, { dropped: i < ALERT_MIN_PLAYS * 0.3 });
    expect(await reliability.checkAlert(NOW)).toBe('alerted');
    expect(posts[0]!.embeds[0]!.title).toBe('Streams are dropping more than usual');
    expect(posts[0]!.embeds[0]!.description).toContain('**30%** of streams');
    // Still bad 15 minutes later: no second alert.
    expect(await reliability.checkAlert(NOW + 15 * 60_000)).toBeNull();

    // Half an hour later, the last hour is clean.
    for (let i = 0; i < ALERT_MIN_PLAYS; i++) play(-0.25, { dropped: false });
    expect(await reliability.checkAlert(NOW + 31 * 60_000)).toBe('recovered');
    expect(posts).toHaveLength(2);
  });

  it('stays quiet without a staff webhook', async () => {
    const { play, staff, reliability } = setup();
    staff.update({ webhookUrl: null }, 'admin');
    for (let i = 0; i < 100; i++) play(0.5, { dropped: true });
    expect(await reliability.checkAlert(NOW)).toBeNull();
  });
});
