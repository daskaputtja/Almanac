import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Reader } from 'mmdb-lib';
import type { SQLInputValue } from 'node:sqlite';
import type { GeoResponse } from '../../shared/geo.js';
import { type Database, transaction } from '../db/database.js';

/**
 * DB-IP's free "IP to City Lite" database (CC BY 4.0), as published on npm
 * by the ip-location-db project. Almanac downloads it into its data folder,
 * checks it against npm's checksum, and looks addresses up locally: no
 * viewer's address is ever sent anywhere.
 */
const PACKAGE = '@ip-location-db/dbip-city-mmdb';
const REGISTRY = 'https://registry.npmjs.org';
const FILES = ['dbip-city-ipv4.mmdb', 'dbip-city-ipv6.mmdb'] as const;
const REFRESH_DAYS = 30;
const RELOOKUP_DAYS = 60;
const BATCH = 20_000;
const COUNTED = '(p.watched_seconds IS NULL OR p.watched_seconds >= 30)';

interface Meta {
  version: string;
  downloadedAt: string;
  buildDate: string | null;
}

interface CityRecord {
  city?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
  state1?: string;
}

/** The database's build date as YYYY-MM-DD. mmdb-lib gives a Date; older versions gave seconds. */
export function buildDateOf(epoch: unknown): string | null {
  const date = epoch instanceof Date ? epoch : typeof epoch === 'number' || typeof epoch === 'bigint' ? new Date(Number(epoch) * 1000) : null;
  if (!date || Number.isNaN(date.getTime()) || date.getFullYear() < 2000 || date.getFullYear() > 2100) return null;
  return date.toISOString().slice(0, 10);
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(v4);
  return /^(fe80|fc|fd)/i.test(ip) || ip === '::1';
}

/** Read the files out of a .tar (only regular files, no paths). */
export function untar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]!);
    offset += 512;
    if (type === '0' || type === '\0') files.set(name.split('/').pop()!, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

export class GeoService {
  private readonly dir: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly db: Database,
    dataDir: string,
    private readonly log: (message: string) => void = console.log,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dir = join(dataDir, 'geo');
  }

  start(): void {
    const run = () => void this.run();
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, 15 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  meta(): Meta | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'meta.json'), 'utf8')) as Meta;
    } catch {
      return null;
    }
  }

  ready(): boolean {
    return Boolean(this.meta()) && FILES.every((f) => existsSync(join(this.dir, f)));
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.ensureDatabase();
      if (this.ready()) this.lookupPending();
    } catch (err) {
      this.log(`Viewer locations: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Download the location database if it's missing or a month old. */
  async ensureDatabase(): Promise<void> {
    const meta = this.meta();
    if (meta && this.ready() && Date.now() - Date.parse(meta.downloadedAt) < REFRESH_DAYS * 86_400_000) return;

    const latest = await this.json<{ version: string; dist: { tarball: string; integrity?: string } }>(`${REGISTRY}/${PACKAGE}/latest`);
    if (meta && this.ready() && meta.version === latest.version) {
      this.writeMeta({ ...meta, downloadedAt: new Date().toISOString() });
      return;
    }

    this.log(`Downloading the viewer location database (${latest.version}, about 65 MB)…`);
    const res = await this.fetchImpl(latest.dist.tarball, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const tarball = Buffer.from(await res.arrayBuffer());
    const [algorithm, expected] = (latest.dist.integrity ?? '').split('-', 2);
    if (algorithm !== 'sha512' || !expected) throw new Error('npm gave no checksum for the download, so it was not used.');
    if (createHash('sha512').update(tarball).digest('base64') !== expected) throw new Error('the download didn’t match its checksum, so it was not used.');

    const files = untar(gunzipSync(tarball));
    mkdirSync(this.dir, { recursive: true });
    let buildDate: string | null = null;
    for (const name of FILES) {
      const data = files.get(name);
      if (!data) throw new Error(`${name} was missing from the download.`);
      const reader = new Reader(Buffer.from(data)); // throws if the file is damaged
      buildDate ??= buildDateOf(reader.metadata.buildEpoch);
      writeFileSync(join(this.dir, `${name}.tmp`), data);
      renameSync(join(this.dir, `${name}.tmp`), join(this.dir, name));
    }
    this.writeMeta({ version: latest.version, downloadedAt: new Date().toISOString(), buildDate });
    // Look everything up again with the new data, a batch at a time.
    this.db.prepare('DELETE FROM ip_locations').run();
    this.log('Viewer location database ready.');
  }

  /** Locate addresses from play history that haven't been looked up (or not recently). */
  lookupPending(now = Date.now()): number {
    const stale = new Date(now - RELOOKUP_DAYS * 86_400_000).toISOString();
    const ips = (
      this.db
        .prepare(
          `SELECT DISTINCT p.client_ip AS ip FROM plays p LEFT JOIN ip_locations l ON l.ip = p.client_ip
           WHERE p.client_ip IS NOT NULL AND p.client_ip <> '' AND (l.ip IS NULL OR l.looked_up_at < ?) LIMIT ?`,
        )
        .all(stale, BATCH) as { ip: string }[]
    ).map((r) => r.ip);
    if (!ips.length) return 0;

    // The readers hold about 130 MB; they're only loaded for the batch.
    const v4 = new Reader(readFileSync(join(this.dir, FILES[0])));
    const v6 = new Reader(readFileSync(join(this.dir, FILES[1])));
    const insert = this.db.prepare(
      `INSERT INTO ip_locations (ip, country_code, region, city, latitude, longitude, looked_up_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ip) DO UPDATE SET country_code = excluded.country_code, region = excluded.region, city = excluded.city,
         latitude = excluded.latitude, longitude = excluded.longitude, looked_up_at = excluded.looked_up_at`,
    );
    const at = new Date(now).toISOString();
    transaction(this.db, () => {
      for (const ip of ips) {
        if (isPrivateAddress(ip)) {
          insert.run(ip, 'LAN', null, null, null, null, at);
          continue;
        }
        let record: CityRecord | null = null;
        try {
          record = (ip.includes(':') && !ip.startsWith('::ffff:') ? v6 : v4).get(ip.replace(/^::ffff:/, '')) as unknown as CityRecord | null;
        } catch {
          record = null;
        }
        insert.run(
          ip,
          record?.country_code || null,
          record?.state1 || null,
          record?.city || null,
          typeof record?.latitude === 'number' ? Math.round(record.latitude * 100) / 100 : null,
          typeof record?.longitude === 'number' ? Math.round(record.longitude * 100) / 100 : null,
          at,
        );
      }
    });
    return ips.length;
  }

  /** Plays by country (and, for admins, by city) for a period and optionally one user. */
  map(query: { from?: string; userId?: string; minWatchedSeconds?: number }, includeCities: boolean): GeoResponse {
    const where = ['1 = 1'];
    const params: SQLInputValue[] = [];
    if (query.from) {
      where.push('p.started_at >= ?');
      params.push(query.from);
    }
    if (query.userId) {
      where.push('p.user_id = ?');
      params.push(query.userId);
    }
    if (query.minWatchedSeconds) where.push(COUNTED);
    const W = `WHERE ${where.join(' AND ')}`;

    const countries = this.db
      .prepare(
        `SELECT l.country_code AS code, COUNT(*) AS plays, COUNT(DISTINCT p.user_id) AS viewers
         FROM plays p JOIN ip_locations l ON l.ip = p.client_ip ${W} AND l.country_code IS NOT NULL AND l.country_code <> 'LAN'
         GROUP BY l.country_code ORDER BY viewers DESC, plays DESC`,
      )
      .all(...params) as unknown as GeoResponse['countries'];

    const cities = includeCities
      ? (this.db
          .prepare(
            `SELECT l.country_code AS country, l.city AS city, MAX(l.region) AS region,
                    ROUND(AVG(l.latitude), 2) AS lat, ROUND(AVG(l.longitude), 2) AS lon,
                    COUNT(*) AS plays, COUNT(DISTINCT p.user_id) AS viewers
             FROM plays p JOIN ip_locations l ON l.ip = p.client_ip ${W}
               AND l.city IS NOT NULL AND l.city <> '' AND l.latitude IS NOT NULL AND l.country_code <> 'LAN'
             GROUP BY l.country_code, l.city ORDER BY viewers DESC, plays DESC LIMIT 400`,
          )
          .all(...params) as unknown as GeoResponse['cities'])
      : [];

    const other = this.db
      .prepare(
        `SELECT SUM(l.country_code = 'LAN') AS local,
                SUM(l.ip IS NULL OR l.country_code IS NULL) AS unknown
         FROM plays p LEFT JOIN ip_locations l ON l.ip = p.client_ip ${W}`,
      )
      .get(...params) as { local: number | null; unknown: number | null };

    return {
      ready: this.ready(),
      dataDate: /^20\d\d-\d\d-\d\d$/.test(this.meta()?.buildDate ?? '') ? this.meta()!.buildDate : null,
      countries,
      cities,
      local: other.local ?? 0,
      unknown: other.unknown ?? 0,
    };
  }

  private async json<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`couldn’t check for location data (${res.status}).`);
    return (await res.json()) as T;
  }

  private writeMeta(meta: Meta): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }
}
