import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, validateThresholds, withDefaults } from '../shared/moderation.js';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { type PlayForDetection, THRESHOLDS, detectFlags, networkOf } from '../server/moderation/detect.js';
import { type Actor, ModerationService } from '../server/moderation/service.js';
import type { SiloHistoryEntry } from '../server/silo/types.js';

const HOUR = 3_600_000;
const BASE = Date.parse('2026-06-10T00:00:00Z');

function play(startHour: number, hours: number, extra: Partial<PlayForDetection> = {}): PlayForDetection {
  return {
    startedAt: new Date(BASE + startHour * HOUR).toISOString(),
    endedAt: new Date(BASE + (startHour + hours) * HOUR).toISOString(),
    mediaType: 'episode',
    title: 'Episode',
    seriesTitle: 'Show',
    watchedSeconds: hours * 3600,
    pausedSeconds: 0,
    completed: false,
    durationSeconds: hours * 3600,
    ip: '203.0.113.10',
    deviceId: 'device-1',
    player: 'Silo Android TV',
    ...extra,
  };
}

const kinds = (flags: ReturnType<typeof detectFlags>) => flags.map((f) => f.kind);

describe('networkOf', () => {
  it('groups addresses by network', () => {
    expect(networkOf('203.0.113.10')).toBe(networkOf('203.0.113.250'));
    expect(networkOf('203.0.113.10')).not.toBe(networkOf('203.0.114.10'));
    expect(networkOf('2001:db8:1:2:aaaa::1')).toBe(networkOf('2001:db8:1:2:bbbb::9'));
    expect(networkOf('192.168.1.20')).toBe('local network');
    expect(networkOf('10.0.0.5')).toBe('local network');
    expect(networkOf('::ffff:198.51.100.7')).toBe(networkOf('198.51.100.9'));
    expect(networkOf(null)).toBeNull();
  });
});

describe('detectFlags', () => {
  it('leaves an ordinary viewer alone', () => {
    const plays = [play(19, 1), play(20, 1), play(43, 2), play(67, 1.5), play(68.6, 0.8, { ip: '198.51.100.4' })];
    expect(detectFlags(plays, 7)).toEqual([]);
  });

  it('does not flag two networks at once (a phone and the TV at home)', () => {
    expect(kinds(detectFlags([play(10, 2), play(10.5, 1, { ip: '198.51.100.4' })], 7))).toEqual([]);
  });

  it('flags three or more networks at the same time', () => {
    const three = [play(10, 2), play(10.5, 1, { ip: '198.51.100.4', deviceId: 'device-2' }), play(10.6, 1, { ip: '192.0.2.8', deviceId: 'device-3' })];
    const flags = detectFlags(three, 7);
    expect(kinds(flags)).toEqual(['concurrent_networks']);
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.adminDetails[0]).toMatch(/Networks:/);
    expect(flags[0]!.headline).not.toMatch(/\d+\.\d+\.\d+/); // no addresses in what mods see
    expect(flags[0]!.details.join(' ')).not.toMatch(/\d+\.\d+\.\d+\.\d+/);

    const four = [...three, play(10.7, 1, { ip: '198.18.0.1', deviceId: 'device-4' })];
    expect(detectFlags(four, 7)[0]!.severity).toBe('high');
  });

  it('doesn’t count one device in two places, or a timed-out stream’s last minutes', () => {
    // A phone switches from Wi-Fi to mobile data: same device, new network.
    const phone = [play(10, 1), play(10.5, 1, { ip: '198.51.100.4' }), play(10.6, 1, { ip: '192.0.2.8' })];
    expect(kinds(detectFlags(phone, 7))).not.toContain('concurrent_networks');
    // Three devices, but one stream had already died (it timed out 8 minutes later).
    const stale = [
      play(10, 0.6, { deviceId: 'a', endReason: 'expired' }),
      play(10.5, 1, { ip: '198.51.100.4', deviceId: 'b' }),
      play(10.55, 1, { ip: '192.0.2.8', deviceId: 'c' }),
    ];
    expect(kinds(detectFlags(stale, 7))).not.toContain('concurrent_networks');
  });

  it('says where simultaneous streams were', () => {
    const three = [play(10, 2), play(10.5, 1, { ip: '198.51.100.4', deviceId: 'b' }), play(10.6, 1, { ip: '192.0.2.8', deviceId: 'c' })];
    const places: Record<string, { country: string; city: string }> = {
      '203.0.113.10': { country: 'GB', city: 'Leeds' },
      '198.51.100.4': { country: 'SE', city: 'Gothenburg' },
      '192.0.2.8': { country: 'CA', city: 'Montreal' },
    };
    const flag = detectFlags(three, 7, [], undefined, undefined, (ip) => places[ip] ?? null).find((f) => f.kind === 'concurrent_networks')!;
    expect(flag.details.join(' ')).toContain('3 different countries: United Kingdom, Sweden, Canada');
    expect(flag.details.join(' ')).not.toContain('Leeds'); // towns are for admins
    expect(flag.adminDetails.join(' ')).toContain('Leeds, United Kingdom');
  });

  it('counts web browsers on one network as one device', () => {
    const browsers = Array.from({ length: 9 }, (_, i) => play(i * 3, 1, { deviceId: `browser-${i}`, player: 'Silo Web' }));
    expect(kinds(detectFlags(browsers, 7))).not.toContain('many_devices');
  });

  it('spots impossible travel between devices, day after day, but not one device jumping about', () => {
    const places: Record<string, { country: string; city: string; lat: number; lon: number }> = {
      '203.0.113.10': { country: 'CA', city: 'Montreal', lat: 45.5, lon: -73.6 },
      '198.51.100.4': { country: 'IE', city: 'Cork', lat: 51.9, lon: -8.5 },
    };
    const locate = (ip: string) => places[ip] ?? null;
    // Each evening for five days: a TV in Montreal, then a phone in Cork an hour later.
    const twoHomes = Array.from({ length: 5 }, (_, d) => [
      play(d * 24 + 18, 1, { deviceId: 'tv' }),
      play(d * 24 + 20, 1, { deviceId: 'phone', ip: '198.51.100.4' }),
    ]).flat();
    const flag = detectFlags(twoHomes, 7, [], undefined, undefined, locate).find((f) => f.kind === 'impossible_travel')!;
    expect(flag.severity).toBe('low');
    expect(flag.headline).toBe('Played in places too far apart to travel between, on 5 days this week');
    expect(flag.details[0]).toContain('Canada, then Ireland 1 h 0 min later');
    expect(flag.details[0]).toMatch(/\d,\d{3} miles apart/);
    expect(flag.details.join(' ')).not.toContain('Montreal'); // towns are for admins
    expect(flag.adminDetails[0]).toContain('Montreal, Canada, then Cork, Ireland');

    // The same, but it's one device (a VPN switching countries): not flagged.
    const vpn = twoHomes.map((p) => ({ ...p, deviceId: 'phone' }));
    expect(kinds(detectFlags(vpn, 7, [], undefined, undefined, locate))).not.toContain('impossible_travel');
    // Plenty of time to fly between them: not flagged.
    const flights = Array.from({ length: 5 }, (_, d) => [play(d * 48, 1, { deviceId: 'tv' }), play(d * 48 + 12, 1, { deviceId: 'phone', ip: '198.51.100.4' })]).flat();
    expect(kinds(detectFlags(flights, 7, [], undefined, undefined, locate))).not.toContain('impossible_travel');
  });

  it('counts live streams too', () => {
    const live = [{ ip: '203.0.113.1', player: 'A' }, { ip: '198.51.100.1', player: 'B' }, { ip: '192.0.2.1', player: 'C' }];
    const flags = detectFlags([], 7, live);
    expect(flags[0]!.details[0]).toMatch(/right now/);
  });

  it('treats every private address as one home network', () => {
    const plays = [play(10, 2, { ip: '192.168.1.2' }), play(10.5, 1, { ip: '192.168.1.3' }), play(10.6, 1, { ip: '10.0.0.4' })];
    expect(detectFlags(plays, 7)).toEqual([]);
  });

  it('flags many networks or devices in the window', () => {
    const plays = Array.from({ length: THRESHOLDS.networksInWindow.low }, (_, i) => play(i * 5, 1, { ip: `198.51.${i}.1`, deviceId: `d${i % 3}` }));
    expect(kinds(detectFlags(plays, 7))).toContain('many_networks');
    const devices = Array.from({ length: THRESHOLDS.devicesInWindow.low }, (_, i) => play(i * 5, 1, { deviceId: `device-${i}` }));
    expect(kinds(detectFlags(devices, 7))).toEqual(['many_devices']);
  });

  it('flags non-stop playback, but not a long binge', () => {
    // 10 hours of episodes back to back: a long evening, fine.
    const binge = Array.from({ length: 10 }, (_, i) => play(i, 0.95));
    expect(kinds(detectFlags(binge, 7))).not.toContain('nonstop');
    // 30 hours with only 5-minute gaps.
    const marathon = Array.from({ length: 30 }, (_, i) => play(i, 0.9));
    const flags = detectFlags(marathon, 7);
    expect(kinds(flags)).toContain('nonstop');
    expect(flags.find((f) => f.kind === 'nonstop')!.headline).toMatch(/30 hours without a break/);
  });

  it('flags playing most of every day', () => {
    const plays = Array.from({ length: 7 }, (_, day) => play(day * 24, 20));
    const flag = detectFlags(plays, 7).find((f) => f.kind === 'heavy_daily')!;
    expect(flag.severity).toBe('high');
    expect(flag.headline).toMatch(/20\.0 hours/);
  });

  it('flags hours of titles watched back to back, never as serious', () => {
    // Twenty-two 45-minute episodes, one after another: about 16.5 hours.
    const chain = Array.from({ length: 22 }, (_, i) => play(i * 0.77, 0.75, { completed: true }));
    const flag = detectFlags(chain, 7).find((f) => f.kind === 'back_to_back')!;
    expect(flag.headline).toBe('Watched 17 hours of titles back to back, each to the end');
    expect(flag.severity).toBe('medium');
    expect(flag.details[1]).toMatch(/Mostly Show \(22 of 22\)/);
    // With pauses it's normal viewing.
    const paused = chain.map((p) => ({ ...p, pausedSeconds: 300 }));
    expect(kinds(detectFlags(paused, 7))).not.toContain('back_to_back');
  });

  it('counts hours, not titles, so short cartoons on autoplay don’t look like a hundred films', () => {
    // A hundred 5-minute episodes: about 8.3 hours, just over the "minor" level.
    const cartoons = Array.from({ length: 100 }, (_, i) => play(i * (5.5 / 60), 5 / 60, { completed: true, seriesTitle: 'Cartoon' }));
    const flag = detectFlags(cartoons, 7).find((f) => f.kind === 'back_to_back')!;
    expect(flag.severity).toBe('low');
    expect(flag.headline).toMatch(/Watched 8 hours/);
  });

  it('doesn’t count titles skipped through to the end', () => {
    // Twelve two-hour movies "finished" in 15 minutes each by jumping to the end.
    const skipped = Array.from({ length: 12 }, (_, i) =>
      play(i * 0.26, 0.25, { mediaType: 'movie', completed: true, durationSeconds: 7200, watchedSeconds: 180 }),
    );
    expect(kinds(detectFlags(skipped, 7))).not.toContain('back_to_back');
  });
});

// ---------------------------------------------------------------------------

function historyEntry(i: number, startMs: number, hours: number, ip: string, userId = '42'): SiloHistoryEntry {
  return {
    session_id: `s${userId}-${i}`,
    user_id: userId,
    username: `user${userId}`,
    profile_id: 'p',
    profile_name: 'Main',
    media_item_id: `item${i}`,
    media_file_id: `f${i}`,
    media_title: `Title ${i}`,
    media_type: 'movie',
    play_method: 'direct',
    started_at: new Date(startMs).toISOString(),
    ended_at: new Date(startMs + hours * HOUR).toISOString(),
    end_position_seconds: hours * 3600,
    duration_seconds: hours * 3600,
    completed: false,
    played_seconds: hours * 3600,
    series_title: '',
    season_number: null,
    episode_number: null,
    measured: true,
    start_position_seconds: 0,
    paused_seconds: 0,
    client_ip: ip,
    device_id: `d-${ip}`,
    device_platform: 'android-tv',
    client_name: 'Silo Android TV',
    client_version: '1',
    video_decision: 'direct',
    audio_decision: 'direct',
    end_reason: 'stopped',
    subtitle: null,
    lifecycle_seq: i,
  };
}

const admin: Actor = { id: 1, name: 'alex', manageAllNotes: true };
const mod: Actor = { id: 2, name: 'morgan', manageAllNotes: false };

function setup() {
  const db = openDatabase(':memory:');
  const history = new HistoryStore(db);
  const service = new ModerationService(db);
  const now = Date.now();
  const sharing = (networks: number, offset = 0) =>
    Array.from({ length: networks }, (_, i) => historyEntry(i + offset, now - 5 * HOUR + i * 60_000, 2, `198.51.${i + offset}.1`));
  return { db, history, service, now, sharing };
}

describe('ModerationService', () => {
  it('stores flags and hides admin details from mods', () => {
    const { history, service, now, sharing } = setup();
    history.upsert(sharing(3));
    service.refresh(new Map(), now);
    const forMod = service.flags({ status: 'open', includeAdminDetails: false });
    expect(forMod.flags).toHaveLength(1);
    expect(forMod.flags[0]).toMatchObject({ kind: 'concurrent_networks', group: 'sharing', username: 'user42', status: 'open', adminDetails: [] });
    expect(forMod.counts).toEqual({ open: 1, openHigh: 0 });
    expect(service.flags({ status: 'open', includeAdminDetails: true }).flags[0]!.adminDetails[0]).toMatch(/198\.51\.0\.x/);
  });

  it('reviews a flag, notes it, and reopens it if it gets worse', () => {
    const { history, service, now, sharing } = setup();
    history.upsert(sharing(3));
    service.refresh(new Map(), now);
    const id = service.flags({ status: 'all', includeAdminDetails: false }).flags[0]!.id;

    service.review(id, mod, 'Family, OK');
    expect(service.flags({ status: 'open', includeAdminDetails: false }).flags).toHaveLength(0);
    const reviewed = service.flags({ status: 'reviewed', includeAdminDetails: false }).flags[0]!;
    expect(reviewed.review).toMatchObject({ by: 'morgan', note: 'Family, OK' });
    expect(service.notes('42', mod)[0]!.body).toMatch(/Reviewed flag: Streamed from 3 different networks.*Family, OK/);

    // Same behaviour again: stays reviewed.
    service.refresh(new Map(), now + 60_000);
    expect(service.flags({ status: 'open', includeAdminDetails: false }).flags).toHaveLength(0);

    // Worse: a fourth network joins, and it reopens as serious.
    history.upsert(sharing(1, 3));
    service.refresh(new Map(), now + 120_000);
    const reopened = service.flags({ status: 'open', includeAdminDetails: false }).flags[0]!;
    expect(reopened.severity).toBe('high');
    expect(reopened.review).toBeNull();
  });

  it('marks flags inactive once the behaviour stops', () => {
    const { history, service, now, sharing } = setup();
    history.upsert(sharing(3));
    service.refresh(new Map(), now);
    service.refresh(new Map(), now + 8 * 86_400_000); // a week and a day later
    expect(service.flags({ status: 'all', includeAdminDetails: false }).flags).toHaveLength(0);
    expect(service.flags({ status: 'all', includeAdminDetails: false, includeInactive: true }).flags[0]!.active).toBe(false);
  });

  it('lets mods edit only their own notes, and admins any', () => {
    const { service } = setup();
    service.addNote('42', mod, 'Asked about buffering');
    service.addNote('42', admin, 'Upgraded to 4 streams');
    const [adminNote, modNote] = service.notes('42', mod);
    expect(adminNote!.canEdit).toBe(false);
    expect(modNote!.canEdit).toBe(true);
    expect(() => service.editNote(adminNote!.id, mod, 'changed')).toThrow(/own notes/);
    service.editNote(modNote!.id, mod, 'Asked about buffering on Roku');
    service.deleteNote(modNote!.id, admin);
    expect(service.notes('42', admin).map((n) => n.body)).toEqual(['Upgraded to 4 streams']);
    expect(() => service.addNote('42', mod, '   ')).toThrow(/Write something/);
  });

  it('keeps tags tidy', () => {
    const { service } = setup();
    expect(service.setTags('42', mod, ['VIP', ' vip ', 'Warned', '', 7, 'Family  member'])).toEqual(['VIP', 'Warned', 'Family member']);
    service.setTags('43', mod, ['vip']);
    const tags = service.tags();
    expect(tags.byUser['42']).toEqual(['Family member', 'VIP', 'Warned']);
    expect(tags.all[0]).toEqual({ tag: 'VIP', users: 2 });
    service.setTags('42', mod, ['Warned']);
    expect(service.tags().byUser['42']).toEqual(['Warned']);
    expect(() => service.setTags('42', mod, ['x'.repeat(40)])).toThrow(/32 characters/);
  });
});

// ---------------------------------------------------------------------------
// Adjustable thresholds


describe('thresholds', () => {
  it('validates levels', () => {
    expect(validateThresholds({})).toEqual(DEFAULT_THRESHOLDS);
    expect(validateThresholds({ concurrentNetworks: { enabled: true, medium: 4, high: 3 } })).toMatch(/higher than the one before/);
    expect(validateThresholds({ concurrentNetworks: { enabled: true, medium: 1, high: 3 } })).toMatch(/between 2 and 20/);
    expect(validateThresholds({ dailyHours: { enabled: true, medium: 'lots' } })).toMatch(/enter a number/);
    const ok = validateThresholds({ nonstopHours: { enabled: false, medium: 30, high: 60 } });
    expect(ok).toMatchObject({ nonstopHours: { enabled: false, medium: 30, high: 60 } });
    expect(withDefaults(null)).toEqual(DEFAULT_THRESHOLDS);
    expect(withDefaults({ nonsense: true })).toEqual(DEFAULT_THRESHOLDS);
  });

  it('uses the levels it is given, and skips checks that are off', () => {
    const three = [play(10, 2), play(10.5, 1, { ip: '198.51.100.4', deviceId: 'device-2' }), play(10.6, 1, { ip: '192.0.2.8', deviceId: 'device-3' })];
    const stricter = { ...DEFAULT_THRESHOLDS, concurrentNetworks: { enabled: true, medium: 2, high: 3 } };
    expect(detectFlags(three, 7, [], stricter)[0]!.severity).toBe('high');
    const off = { ...DEFAULT_THRESHOLDS, concurrentNetworks: { enabled: false, medium: 3, high: 4 } };
    expect(detectFlags(three, 7, [], off)).toEqual([]);
    const two = [play(10, 2), play(10.5, 1, { ip: '198.51.100.4', deviceId: 'device-2' })];
    expect(kinds(detectFlags(two, 7, [], stricter))).toEqual(['concurrent_networks']);
  });

  it('previews, saves and re-checks every account', () => {
    const { history, service, now, sharing } = setup();
    history.upsert(sharing(3));
    service.refresh(new Map(), now);
    expect(service.flags({ status: 'open', includeAdminDetails: false }).flags).toHaveLength(1);

    const looser = { ...DEFAULT_THRESHOLDS, concurrentNetworks: { enabled: true, medium: 5, high: 6 } };
    const preview = service.preview(looser, now);
    expect(preview.current.accounts).toBe(1);
    expect(preview.current.byKind.concurrent_networks.medium).toBe(1);
    expect(preview.proposed.accounts).toBe(0);
    // Previewing doesn't change anything.
    expect(service.flags({ status: 'open', includeAdminDetails: false }).flags).toHaveLength(1);

    service.setThresholds(looser, 'alex');
    expect(service.thresholdsResponse()).toMatchObject({ thresholds: looser, updatedBy: 'alex' });
  });
});
