import { describe, expect, it } from 'vitest';
import { CapacityService, theilSen } from '../server/capacity/capacity.js';
import { openDatabase } from '../server/db/database.js';
import { compareVersions, PlaybackHealth } from '../server/health/health.js';
import { appDescription, describeDevice, deviceTips, thirdPartyNote } from '../server/health/devices.js';
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
    expect(drops.headline).toBe('9 of 35 streams dropped (26%; about 4% for others on the same apps)');
    expect(drops.advice.join(' ')).toMatch(/Most drops are on their Fire TV \(Silo\): 9 of 9/);
    expect(drops.advice.join(' ')).toMatch(/other devices play fine/);
  });

  it('judges viewers against others on the same app, and says when the app is part of it', () => {
    const { plays, health } = setup();
    for (let u = 0; u < 3; u++) plays(`fire${u}`, 15, { dropped: 4, player: 'Flaky Player', platform: 'fire-tv' });
    // As bad as everyone else on that app: not singled out.
    plays('meh', 15, { dropped: 5, player: 'Flaky Player', platform: 'fire-tv' });
    // Far worse than others on it: singled out, and told the app is part of it.
    plays('bad', 15, { dropped: 13, player: 'Flaky Player', platform: 'fire-tv' });
    const users = health.overview(NOW).users;
    expect(users.find((u) => u.userId === 'meh')).toBeUndefined();
    const robin = users.find((u) => u.userId === 'bad')!;
    expect(robin.issues[0]!.advice.join(' ')).toMatch(/Flaky Player drops more streams than most apps for everyone \(2\d%\)/);
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
    expect(issue.advice[0]).toMatch(/Mostly on their Roku \(Old Box\)/);
    expect([...issue.advice, ...issue.device!.tips].join(' ')).toMatch(/HEVC/);
    // And for their device specifically.
    expect(issue.device!.name).toBe('Roku');
    expect(issue.device!.tips.join(' ')).toMatch(/Cheaper and older Rokus can’t play HEVC/);
    expect(issue.device!.tips.join(' ')).toMatch(/DTS or TrueHD/);
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
    expect(mine.user.message).toBeNull();
    expect(mine.user.dropped).toBe(5);
    expect(health.forUser('nobody', NOW)).toBeNull();
    expect(health.forUser('ok1', NOW)!.user.issues).toEqual([]);
  });

  it('doesn’t count drops from apps that never say they stopped, or titles watched to the end', () => {
    const { db, plays, health } = setup();
    // Every stream in this app ends without a stop, for everyone.
    for (let u = 0; u < 3; u++) plays(`quiet${u}`, 12, { dropped: 12, player: 'Quiet App', platform: 'tizen' });
    plays('bad', 15, { dropped: 15, player: 'Quiet App', platform: 'tizen' });
    plays('bad', 12, { player: 'Silo', platform: 'android-tv' });
    expect(health.overview(NOW).users.find((u) => u.userId === 'bad')).toBeUndefined();
    const mine = health.forUser('bad', NOW)!;
    expect(mine.user.dropPlays).toBe(12);
    expect(mine.user.players.find((p) => p.label === 'Quiet App')).toMatchObject({ plays: 15, dropPlays: 0, dropped: 0 });

    // A stream that "expired" after being watched to the end isn't a drop either.
    db.prepare("UPDATE plays SET client_name = 'Silo', end_reason = 'expired', completed = 1 WHERE user_id = 'ok1'").run();
    expect(health.forUser('ok1', NOW)!.user.dropped).toBe(0);
  });

  it('ignores plays older than 30 days', () => {
    const { plays, health } = setup();
    plays('bad', 20, { dropped: 15, daysAgo: 40 });
    expect(health.forUser('bad', NOW)).toBeNull();
  });
});

describe('devices', () => {
  it('recognises devices from what Silo reports', () => {
    const d = (platform: string | null, client: string | null, model: string | null) => describeDevice(platform, client, model);
    expect(d('android-tv', 'Silo Android TV', 'Amazon AFTKA')).toEqual({ kind: 'fire-tv-4k', name: 'Fire TV Stick 4K Max (2021)' });
    expect(d('android-tv', 'Silo Android TV', 'Amazon AFTSS')).toEqual({ kind: 'fire-tv-hd', name: 'Fire TV Stick Lite' });
    expect(d('android-tv', 'Silo Android TV', 'Amazon AFTZZZ')).toEqual({ kind: 'fire-tv', name: 'Fire TV (AFTZZZ)' });
    expect(d('android-tv', 'Silo Android TV', 'NVIDIA SHIELD Android TV')!.kind).toBe('shield');
    expect(d('android-tv', 'Silo Android TV', 'Google Google TV Streamer')).toEqual({ kind: 'google-tv-streamer', name: 'Google TV Streamer' });
    expect(d('android-tv', 'Silo Android TV', 'Google Chromecast HD')!.kind).toBe('chromecast-hd');
    expect(d('android-tv', 'Silo Android TV', 'onn onn. 4K Plus Streaming')).toEqual({ kind: 'onn', name: 'onn 4K Plus Streaming' });
    expect(d('android-tv', 'Silo Android TV', 'TCL Smart TV Pro')).toEqual({ kind: 'android-tv-set', name: 'TCL Smart TV Pro' });
    expect(d('android-tv', 'Silo Android TV', 'Sony BRAVIA 4K VH21')!.kind).toBe('android-tv-set');
    expect(d('android-tv', 'Silo Android TV', 'SDMC 270')).toEqual({ kind: 'android-tv-box', name: 'SDMC 270' });
    expect(d('tvOS', 'Silo Apple TV', 'Apple TV')!.kind).toBe('apple-tv');
    expect(d('iOS', 'Silo iPad', 'iPad')).toEqual({ kind: 'iphone', name: 'iPad' });
    expect(d('iOS Web', 'Silo Web', 'Safari on iOS')).toEqual({ kind: 'browser', name: 'Safari on iOS' });
    expect(d(null, 'Silo Web', null)).toEqual({ kind: 'browser', name: 'web browser' });
    expect(d(null, 'Jellyfin Roku', null)!.kind).toBe('roku');
    expect(d(null, 'Jellyfin for WebOS', null)!.kind).toBe('lg-tv');
    expect(d(null, 'Jellyfin for Tizen', null)!.kind).toBe('samsung-tv');
    expect(d('xbox', 'Silolux for Xbox', null)!.kind).toBe('xbox');
    expect(d('android', 'Silo Android', 'samsung SM-S938B')).toEqual({ kind: 'android-phone', name: 'Samsung SM-S938B' });
    expect(d(null, 'Infuse-Direct', null)).toBeNull();
    expect(d('windows', 'Silage', 'DESKTOP-1')).toEqual({ kind: 'computer', name: 'computer', detail: 'DESKTOP-1 · Windows' });
    expect(d(null, 'Jellyfin Media Player', null)).toEqual({ kind: 'computer', name: 'computer', detail: null });
    expect(appDescription('Jellyfin Media Player')).toBe('a desktop app for Windows, Mac and Linux');
    expect(appDescription('Kodi JellyCon')).toMatch(/Kodi add-on/);
    expect(appDescription('Silo Web')).toBeNull();
  });

  it('gives tips for the device and the reasons', () => {
    const lite = describeDevice('android-tv', 'Silo Android TV', 'Amazon AFTSS')!;
    expect(deviceTips(lite, 'drops').join(' ')).toMatch(/Ethernet Adapter for Fire TV/);
    expect(deviceTips(lite, 'transcoding', ['video_codec_unsupported']).join(' ')).toMatch(/1080p model/);
    const roku = describeDevice('roku', 'Moonfin Roku', null)!;
    expect(deviceTips(roku, 'transcoding', ['audio_codec_unsupported', 'subtitle_burn_in']).join(' ')).toMatch(/DTS or TrueHD.*image subtitles/);
    expect(deviceTips(roku, 'transcoding', ['container_unsupported'])).toEqual([]);
    expect(thirdPartyNote(describeDevice('android-tv', 'Jellyfin Android TV', 'NVIDIA SHIELD Android TV')!, 'Jellyfin Android TV')).toMatch(/third-party app.*NVIDIA Shield/);
    expect(thirdPartyNote(roku, 'Moonfin Roku')).toBeNull(); // no Silo app to suggest on Roku
    expect(thirdPartyNote(lite, 'Silo Android TV')).toBeNull();
  });

  it('compares app versions and suggests updating an old one', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.2+py3', '1.0.2')).toBe(0);
    const db = openDatabase(':memory:');
    const insert = db.prepare(
      `INSERT INTO plays (session_id, user_id, username, profile_id, media_type, title, started_at, ended_at, end_position,
         watched_seconds, completed, play_method, client_name, client_version, device_platform, end_reason, imported_at)
       VALUES (?, ?, ?, 'p', 'movie', 'T', ?, ?, 0, 1800, 0, 'direct', 'Silo Android TV', ?, 'android-tv', ?, ?)`,
    );
    let n = 0;
    const add = (user: string, count: number, dropped: number, version: string) => {
      for (let i = 0; i < count; i++) {
        const at = NOW - DAY - i * HOUR;
        insert.run(`s${++n}`, user, user, new Date(at).toISOString(), new Date(at + HOUR).toISOString(), version, i < dropped ? 'expired' : 'stopped', new Date(NOW).toISOString());
      }
    };
    for (let u = 0; u < 6; u++) add(`ok${u}`, 30, 1, '1.2.0');
    add('old', 20, 12, '1.0.0');
    const user = new PlaybackHealth(db).overview(NOW).users.find((u) => u.userId === 'old')!;
    expect(user.players[0]).toMatchObject({ version: '1.0.0', newerVersion: '1.2.0' });
    expect(user.issues[0]!.advice.join(' ')).toMatch(/Their Silo Android TV is version 1\.0\.0, but others are on 1\.2\.0/);
    expect(user.message).toMatch(/• Update the Silo Android TV app on your Android TV device: you’re on version 1\.0\.0, and 1\.2\.0 is out\./);
  });

  it('names the device and what helps on it in a viewer’s issues', () => {
    const db = openDatabase(':memory:');
    const insert = db.prepare(
      `INSERT INTO plays (session_id, user_id, username, profile_id, media_type, title, started_at, ended_at, end_position,
         watched_seconds, completed, play_method, client_name, device_platform, device_id, end_reason, imported_at)
       VALUES (?, ?, ?, 'p', 'movie', 'T', ?, ?, 0, 1800, 0, 'direct', ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    const add = (user: string, count: number, dropped: number, client: string, platform: string, device: string) => {
      for (let i = 0; i < count; i++) {
        const at = NOW - DAY - i * HOUR;
        insert.run(`s${++n}`, user, user, new Date(at).toISOString(), new Date(at + HOUR).toISOString(), client, platform, device, i < dropped ? 'expired' : 'stopped', new Date(NOW).toISOString());
      }
    };
    for (let u = 0; u < 8; u++) add(`ok${u}`, 30, 1, 'Silo iPhone', 'iOS', `phone${u}`);
    add('bad', 20, 10, 'Silo Android TV', 'android-tv', 'stick');
    add('bad', 10, 0, 'Silo iPhone', 'iOS', 'phone');
    db.prepare("INSERT INTO registered_devices (user_id, device_id, device_name, platform, synced_at) VALUES ('bad', 'stick', 'Amazon AFTSS', 'android-tv', ?)").run(new Date(NOW).toISOString());

    const user = new PlaybackHealth(db).overview(NOW).users[0]!;
    const drops = user.issues.find((i) => i.kind === 'drops')!;
    expect(drops.advice[0]).toBe('Most drops are on their Fire TV Stick Lite (Silo Android TV): 10 of 10.');
    expect(drops.device!.name).toBe('Fire TV Stick Lite');
    expect(drops.device!.tips.join(' ')).toMatch(/Select and Play\/Pause/);
    expect(user.players.find((p) => p.label === 'Silo Android TV')!.device).toEqual({ kind: 'fire-tv-hd', name: 'Fire TV Stick Lite' });

    // A message for the viewer: their device, what to try, no numbers or staff talk.
    expect(user.message).toMatch(/^Hi,\n\nWe’ve noticed some of your streams have been cutting out on your Fire TV Stick Lite\./);
    expect(user.message).toMatch(/• .*Select and Play\/Pause/);
    expect(user.message).toMatch(/Your other devices seem fine/);
    expect(user.message).not.toMatch(/%|\btheir\b|\bthey\b|Almanac|Most drops/i);
  });
});
