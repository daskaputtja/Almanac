import { describe, expect, it } from 'vitest';
import { CapacityService, theilSen } from '../server/capacity/capacity.js';
import { openDatabase } from '../server/db/database.js';
import { PlaybackHealth } from '../server/health/health.js';
import { StaffAlerts } from '../server/notify/staff.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123';

describe('capacity forecast', () => {
  /**
   * Hourly samples for `days` days. Quiet at 09:00 UTC, busiest at 02:00 UTC
   * (a US evening, across UTC midnight). The evening peak grows by `growth` a day.
   */
  function setup(days: number, opts: { base?: number; growth?: number; spike?: number } = {}) {
    const db = openDatabase(':memory:');
    const insert = db.prepare('INSERT INTO load_points (t, resolution, streams, direct, remux, transcode, egress_kbps) VALUES (?, 300, ?, 0, 0, ?, ?)');
    const start = NOW - days * DAY;
    for (let t = start; t < NOW; t += HOUR) {
      const day = (t - start) / DAY;
      const hour = new Date(t).getUTCHours();
      // 1 at 02:00 UTC, 0 at 14:00 UTC.
      const shape = (Math.cos(((hour - 2) / 24) * 2 * Math.PI) + 1) / 2;
      const peak = (opts.base ?? 20) + (opts.growth ?? 0.5) * day;
      let streams = Math.round(2 + (peak - 2) * shape);
      if (opts.spike && Math.floor(day) === Math.floor(days / 2) && hour === 2) streams = opts.spike;
      insert.run(Math.floor(t / 1000), streams, Math.round(streams / 4), streams * 8000);
    }
    const posts: { embeds: { title: string; description: string; url?: string }[] }[] = [];
    const staff = new StaffAlerts(db, async (_url, init) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    }, () => {});
    staff.update({ webhookUrl: WEBHOOK, baseUrl: 'https://almanac.example' }, 'admin');
    const capacity = new CapacityService(db, staff, () => {});
    return { db, capacity, posts, staff };
  }

  it('fits a straight line that ignores a strange day', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6];
    const ys = [10, 12, 14, 100, 18, 20, 22];
    const { slope, intercept } = theilSen(xs, ys);
    expect(slope).toBeCloseTo(2);
    expect(intercept).toBeCloseTo(10);
  });

  it('measures evening peaks and their growth, without limits', () => {
    const { capacity } = setup(50);
    const r = capacity.report(NOW);
    expect(r.historyDays).toBeGreaterThanOrEqual(47);
    const streams = r.metrics.find((m) => m.metric === 'streams')!;
    // Peak today ≈ 20 + 0.5 × 50 = 45.
    expect(streams.typical).toBeGreaterThan(42);
    expect(streams.typical).toBeLessThan(47);
    // 15 more a month on about 45: roughly a third.
    expect(streams.growthPerMonth).toBeGreaterThan(0.28);
    expect(streams.growthPerMonth).toBeLessThan(0.38);
    expect(streams.status).toBe('unknown');
    expect(streams.fullBy).toBeNull();
    expect(streams.busiest!.value).toBeGreaterThanOrEqual(44);
    expect(r.metrics.find((m) => m.metric === 'mbps')!.typical).toBeGreaterThan(330);
  });

  it('isn’t thrown by one huge evening', () => {
    const { capacity } = setup(50, { growth: 0, spike: 400 });
    const streams = capacity.report(NOW).metrics.find((m) => m.metric === 'streams')!;
    expect(Math.abs(streams.growthPerMonth!)).toBeLessThan(0.02);
    expect(streams.typical).toBe(20);
  });

  it('says when busy evenings reach the limit, and how worried to be', () => {
    const { capacity } = setup(50);
    capacity.setLimits({ streams: 60, mbps: 2000, transcodes: '' }, 'admin');
    const r = capacity.report(NOW);
    const streams = r.metrics.find((m) => m.metric === 'streams')!;
    // 45 now, +0.5 a day: about 30 days to 60.
    const days = (Date.parse(streams.fullBy!) - NOW) / DAY;
    expect(days).toBeGreaterThan(20);
    expect(days).toBeLessThan(35);
    expect(['tight', 'watch']).toContain(streams.status);
    expect(streams.used).toBeCloseTo(45 / 60, 1);

    const mbps = r.metrics.find((m) => m.metric === 'mbps')!;
    expect(mbps.status).toBe('ok'); // ~360 Mbps of 2000, a year+ away
    expect(mbps.fullBy).toBeNull();
    expect(r.metrics.find((m) => m.metric === 'transcodes')!.status).toBe('unknown');
    expect(r.limits).toEqual({ streams: 60, mbps: 2000, transcodes: null });
    expect(r.updatedBy).toBe('admin');
  });

  it('calls it tight when busy evenings are already at the limit', () => {
    const { capacity } = setup(50, { growth: 0, base: 40 });
    capacity.setLimits({ streams: 41 }, 'admin');
    let streams = capacity.report(NOW).metrics.find((m) => m.metric === 'streams')!;
    expect(streams.status).toBe('tight'); // 40 of 41
    expect(streams.fullBy).toBeNull(); // not there yet, and not growing
    capacity.setLimits({ streams: 40 }, 'admin');
    streams = capacity.report(NOW).metrics.find((m) => m.metric === 'streams')!;
    expect(Date.parse(streams.fullBy!)).toBeLessThanOrEqual(NOW);
  });

  it('waits for three weeks of history before forecasting', () => {
    const { capacity } = setup(10);
    capacity.setLimits({ streams: 100 }, 'admin');
    const streams = capacity.report(NOW).metrics.find((m) => m.metric === 'streams')!;
    expect(streams.growthPerMonth).toBeNull();
    expect(streams.fullBy).toBeNull();
    expect(streams.status).toBe('ok'); // judged on the busiest night alone
  });

  it('rejects nonsense limits', () => {
    const { capacity } = setup(1);
    expect(() => capacity.setLimits({ streams: -3 }, 'admin')).toThrow(/positive/);
    expect(() => capacity.setLimits({ mbps: 'lots' }, 'admin')).toThrow(/positive/);
  });

  it('alerts staff once as things get worse, not every check', async () => {
    const { capacity, posts } = setup(50);
    const pushed: string[] = [];
    capacity.onAlert = (m) => pushed.push(m.title);
    capacity.setLimits({ streams: 60 }, 'admin');

    const first = await capacity.checkAlerts(NOW);
    expect(first.map((m) => m.metric)).toEqual(['streams']);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.embeds[0]!.title).toMatch(/streams at once/);
    expect(posts[0]!.embeds[0]!.description).toMatch(/of the 60 streams you set/);
    expect(posts[0]!.embeds[0]!.url).toBe('https://almanac.example/server/capacity');
    expect(pushed).toHaveLength(1);

    expect(await capacity.checkAlerts(NOW + 6 * HOUR)).toEqual([]);
    expect(posts).toHaveLength(1);
  });

  it('stays quiet with no limits, or with capacity alerts turned off', async () => {
    const { capacity, posts, staff } = setup(50);
    expect(await capacity.checkAlerts(NOW)).toEqual([]);
    staff.update({ capacity: false }, 'admin');
    capacity.setLimits({ streams: 50 }, 'admin');
    expect(await capacity.checkAlerts(NOW)).toEqual([]);
    expect(posts).toHaveLength(0);
  });
});

describe('playback health', () => {
  function setup() {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO silo_users (id, username, email, synced_at) VALUES ('bad', 'robin', 'robin@example.com', ?)").run(new Date(NOW).toISOString());
    const insert = db.prepare(
      `INSERT INTO plays (session_id, user_id, username, profile_id, media_type, title, started_at, ended_at, end_position,
         watched_seconds, completed, play_method, client_name, device_platform, end_reason, imported_at)
       VALUES (?, ?, ?, 'p', 'movie', 'T', ?, ?, 0, ?, 0, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    const plays = (
      user: string,
      count: number,
      opts: { dropped?: number; quick?: number; transcodes?: number; player?: string; platform?: string; daysAgo?: number } = {},
    ) => {
      for (let i = 0; i < count; i++) {
        const at = NOW - (opts.daysAgo ?? 1) * DAY - i * HOUR;
        insert.run(
          `s${++n}`,
          user,
          user === 'bad' ? 'robin' : user,
          new Date(at).toISOString(),
          new Date(at + HOUR).toISOString(),
          i < (opts.quick ?? 0) ? 4 : 1800,
          i < (opts.transcodes ?? 0) ? 'transcode' : 'direct',
          opts.player ?? 'Silo',
          opts.platform ?? 'android-tv',
          i >= count - (opts.dropped ?? 0) ? 'expired' : 'stopped',
          new Date(NOW).toISOString(),
        );
      }
    };
    // Everyone else: 3% of streams drop.
    for (let u = 0; u < 10; u++) plays(`ok${u}`, 33, { dropped: 1, player: u < 5 ? 'Silo' : 'Silo Web', platform: u < 5 ? 'android-tv' : 'web' });
    return { db, plays, health: new PlaybackHealth(db) };
  }

  it('finds a viewer whose streams drop on one device, and says it’s the device', () => {
    const { plays, health } = setup();
    plays('bad', 20, { dropped: 9, player: 'Silo', platform: 'fire-tv' });
    plays('bad', 15, { player: 'Silo Web', platform: 'web' });
    const o = health.overview(NOW);
    expect(o.checked).toBe(11);
    expect(o.users.map((u) => u.username)).toEqual(['robin']);
    const robin = o.users[0]!;
    expect(robin.email).toBe('robin@example.com');
    const drops = robin.issues.find((i) => i.kind === 'drops')!;
    expect(drops.severity).toBe('high');
    expect(drops.headline).toBe('9 of 35 streams dropped (26%; usually 5%)');
    expect(drops.advice.join(' ')).toMatch(/Most drops are on Silo on Fire TV \(9 of 9\)/);
    expect(drops.advice.join(' ')).toMatch(/other devices play fine/);
  });

  it('blames the app when it drops for other viewers too', () => {
    const { plays, health } = setup();
    for (let u = 0; u < 3; u++) plays(`fire${u}`, 15, { dropped: 4, player: 'Flaky Player', platform: 'fire-tv' });
    plays('bad', 15, { dropped: 6, player: 'Flaky Player', platform: 'fire-tv' });
    const robin = health.overview(NOW).users.find((u) => u.userId === 'bad')!;
    expect(robin.issues[0]!.advice.join(' ')).toMatch(/Flaky Player drops streams for other viewers too/);
  });

  it('points at the connection when every device drops', () => {
    const { plays, health } = setup();
    plays('bad', 12, { dropped: 4, player: 'Silo', platform: 'fire-tv' });
    plays('bad', 12, { dropped: 4, player: 'Silo Web', platform: 'web' });
    const robin = health.overview(NOW).users.find((u) => u.userId === 'bad')!;
    expect(robin.issues[0]!.advice.join(' ')).toMatch(/every device they use/);
  });

  it('explains constant transcoding from the reasons Silo gave', () => {
    const { db, plays, health } = setup();
    plays('bad', 20, { transcodes: 19, player: 'Old Box', platform: 'roku' });
    const obs = db.prepare(
      `INSERT INTO stream_observations (session_id, user_id, first_seen, last_seen, method, reasons) VALUES (?, 'bad', ?, ?, 'transcode', ?)`,
    );
    const seen = new Date(NOW - DAY).toISOString();
    for (let i = 0; i < 5; i++) obs.run(`o${i}`, seen, seen, JSON.stringify(['video_codec_unsupported', 'audio_codec_unsupported']));
    const robin = health.overview(NOW).users.find((u) => u.userId === 'bad')!;
    const issue = robin.issues.find((i) => i.kind === 'transcoding')!;
    expect(issue.headline).toMatch(/^19 of 20 streams converted/);
    expect(issue.advice[0]).toMatch(/Mostly on Old Box on Roku/);
    expect(issue.advice.join(' ')).toMatch(/HEVC/);
    expect(robin.reasons).toContainEqual(expect.objectContaining({ reason: 'video_codec_unsupported', streams: 5 }));
  });

  it('leaves alone viewers who are fine, or have hardly played anything', () => {
    const { plays, health } = setup();
    plays('bad', 6, { dropped: 5 });
    const o = health.overview(NOW);
    expect(o.users).toEqual([]);
    const mine = health.forUser('bad', NOW)!;
    expect(mine.enoughPlays).toBe(false);
    expect(mine.user.issues).toEqual([]);
    expect(mine.user.dropped).toBe(5);
    expect(health.forUser('nobody', NOW)).toBeNull();
    expect(health.forUser('ok1', NOW)!.user.issues).toEqual([]);
  });

  it('ignores plays older than 30 days', () => {
    const { plays, health } = setup();
    plays('bad', 20, { dropped: 15, daysAgo: 40 });
    expect(health.forUser('bad', NOW)).toBeNull();
  });
});
