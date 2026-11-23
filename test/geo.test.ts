import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../server/db/database.js';
import { GeoService, buildDateOf, isPrivateAddress, untar } from '../server/geo/geo.js';
import { HistoryStore } from '../server/history/store.js';
import { MockHistorySource } from '../server/silo/mock.js';

function tarOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write(Buffer.byteLength(content).toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
    body.write(content);
    parts.push(header, body);
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe('geo helpers', () => {
  it('reads files out of a tar archive', () => {
    const files = untar(tarOf({ 'a.txt': 'hello', 'b.txt': 'x'.repeat(700) }));
    expect(files.get('a.txt')!.toString()).toBe('hello');
    expect(files.get('b.txt')!.length).toBe(700);
  });

  it('reads the database build date however it’s given', () => {
    expect(buildDateOf(new Date('2026-06-05T13:42:02Z'))).toBe('2026-06-05');
    expect(buildDateOf(1780667000)).toBe('2026-06-05');
    expect(buildDateOf(new Date('garbage'))).toBeNull();
    expect(buildDateOf(1780667000000)).toBeNull(); // milliseconds by mistake
  });

  it('knows private addresses', () => {
    for (const ip of ['192.168.1.4', '10.2.3.4', '172.20.0.1', '127.0.0.1', '100.100.1.1', 'fd00::1', '::ffff:192.168.0.9']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '100.128.0.1']) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('GeoService', () => {
  it('refuses a download that doesn’t match npm’s checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'almanac-geo-'));
    const tarball = gzipSync(tarOf({ 'dbip-city-ipv4.mmdb': 'not really', 'dbip-city-ipv6.mmdb': 'not really' }));
    const fakeFetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/latest')) {
        return new Response(JSON.stringify({ version: '9.9.9', dist: { tarball: 'https://registry.example/x.tgz', integrity: 'sha512-AAAA' } }));
      }
      return new Response(tarball);
    }) as typeof fetch;
    const geo = new GeoService(openDatabase(':memory:'), dir, () => {}, fakeFetch);
    await expect(geo.ensureDatabase()).rejects.toThrow(/checksum/);
    expect(geo.ready()).toBe(false);
  });

  it('counts plays by country, and cities only when asked', async () => {
    const db = openDatabase(':memory:');
    const plays = (await new MockHistorySource().listHistoryPage({ limit: 600 })).items;
    new HistoryStore(db).upsert(plays);
    // Locate the demo addresses by hand (the real lookup needs the 130 MB database).
    const insert = db.prepare('INSERT INTO ip_locations (ip, country_code, region, city, latitude, longitude, looked_up_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const ip of new Set(plays.map((p) => p.client_ip!))) {
      if (isPrivateAddress(ip)) insert.run(ip, 'LAN', null, null, null, null, 'now');
      else if (Number(ip.split('.')[3]) % 2) insert.run(ip, 'GB', 'England', 'London', 51.51, -0.09, 'now');
      else insert.run(ip, 'US', 'New York', 'New York', 40.71, -74.0, 'now');
    }
    const geo = new GeoService(db, mkdtempSync(join(tmpdir(), 'almanac-geo-')), () => {});

    const forMods = geo.map({}, false);
    expect(forMods.countries.map((c) => c.code).sort()).toEqual(['GB', 'US']);
    expect(forMods.cities).toEqual([]);
    expect(forMods.local).toBeGreaterThan(0);
    expect(forMods.countries.reduce((s, c) => s + c.plays, 0) + forMods.local + forMods.unknown).toBe(plays.length);
    expect(forMods.ready).toBe(false);

    const forAdmins = geo.map({}, true);
    expect(forAdmins.cities.map((c) => c.city).sort()).toEqual(['London', 'New York']);
    expect(forAdmins.cities[0]).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });

    const oneUser = geo.map({ userId: plays[0]!.user_id }, false);
    expect(oneUser.countries.reduce((s, c) => s + c.plays, 0)).toBeLessThan(forMods.countries.reduce((s, c) => s + c.plays, 0));
  });
});
