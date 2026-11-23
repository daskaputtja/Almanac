import type { LoadBucket, LoadRange, LoadResponse } from '../../shared/load.js';
import { LOAD_RANGES } from '../../shared/load.js';
import { type Database, transaction } from '../db/database.js';
import type { ServerSource } from '../silo/client.js';
import type { SiloLoadPoint } from '../silo/types.js';

const SYNC_EVERY_MS = 10 * 60_000;

/** Bucket sizes per range, so each chart has a few hundred points at most. */
const BUCKET_SECONDS: Record<LoadRange['key'], number> = {
  '24h': 300,
  '7d': 3600,
  '30d': 3 * 3600,
  '90d': 12 * 3600,
  '365d': 86_400,
};

/**
 * Keeps a copy of Silo's load samples (streams, playback methods and
 * bandwidth). Silo holds about 31 days; Almanac keeps them for good, so the
 * Server page can show months and years.
 */
export class LoadHistory {
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly source: ServerSource,
    private readonly log: (message: string) => void = console.log,
  ) {}

  start(): void {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), SYNC_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Copy recent samples; on the first run, everything Silo still has. */
  async sync(): Promise<void> {
    try {
      const empty = (this.db.prepare('SELECT COUNT(*) AS n FROM load_points').get() as { n: number }).n === 0;
      // Coarse first, then finer, so the finest sample wins where they overlap.
      const windows = empty ? [744, 168, 24] : [24];
      for (const hours of windows) {
        const series = await this.source.timeseries(hours);
        this.store(series.points, series.resolution_seconds);
      }
      if (empty) this.log('Copied server load history from Silo.');
      this.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.lastError) this.log(`Load history sync failed: ${message}`);
      this.lastError = message;
    }
  }

  store(points: SiloLoadPoint[], resolution: number): void {
    const insert = this.db.prepare(
      `INSERT INTO load_points (t, resolution, streams, direct, remux, transcode, egress_kbps) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (t) DO UPDATE SET resolution = excluded.resolution, streams = excluded.streams, direct = excluded.direct,
         remux = excluded.remux, transcode = excluded.transcode, egress_kbps = excluded.egress_kbps
       WHERE excluded.resolution <= load_points.resolution`,
    );
    transaction(this.db, () => {
      for (const p of points) {
        const t = Math.floor(Date.parse(p.t) / 1000);
        if (!Number.isFinite(t)) continue;
        insert.run(t, resolution, p.streams ?? 0, p.direct ?? null, p.remux ?? null, p.transcode ?? null, p.egress_kbps ?? null);
      }
    });
  }

  load(rangeKey: LoadRange['key'], now = Date.now()): LoadResponse {
    const range = LOAD_RANGES.find((r) => r.key === rangeKey) ?? LOAD_RANGES[0]!;
    const size = BUCKET_SECONDS[range.key];
    const from = Math.floor(now / 1000) - range.hours * 3600;

    const rows = this.db
      .prepare(
        `SELECT (t / ?) * ? AS bucket, AVG(streams) AS avg_s, MAX(streams) AS max_s,
                AVG(COALESCE(transcode, 0)) AS avg_t, MAX(COALESCE(transcode, 0)) AS max_t,
                AVG(COALESCE(egress_kbps, 0)) AS avg_e, MAX(COALESCE(egress_kbps, 0)) AS max_e
         FROM load_points WHERE t >= ? GROUP BY bucket ORDER BY bucket`,
      )
      .all(size, size, from) as { bucket: number; avg_s: number; max_s: number; avg_t: number; max_t: number; avg_e: number; max_e: number }[];
    const round = (n: number) => Math.round(n * 10) / 10;
    const buckets = rows.map((r): LoadBucket => [r.bucket, round(r.avg_s), r.max_s, round(r.avg_t), r.max_t, round(r.avg_e / 1000), round(r.max_e / 1000)]);

    const peakStreams = this.db
      .prepare('SELECT streams, t FROM load_points WHERE t >= ? ORDER BY streams DESC, t DESC LIMIT 1')
      .get(from) as { streams: number; t: number } | undefined;
    const peakEgress = this.db
      .prepare('SELECT egress_kbps, t FROM load_points WHERE t >= ? AND egress_kbps IS NOT NULL ORDER BY egress_kbps DESC LIMIT 1')
      .get(from) as { egress_kbps: number; t: number } | undefined;
    const totals = this.db
      .prepare('SELECT AVG(streams) AS s, AVG(egress_kbps) AS e, MAX(transcode) AS mt FROM load_points WHERE t >= ?')
      .get(from) as { s: number | null; e: number | null; mt: number | null };

    // Hourly averages over 4 weeks, for the "typical week" heatmap and the quietest hour.
    const weekly = (
      this.db
        .prepare('SELECT (t / 3600) * 3600 AS hour, AVG(streams) AS s FROM load_points WHERE t >= ? GROUP BY hour ORDER BY hour')
        .all(Math.floor(now / 1000) - 28 * 86_400) as { hour: number; s: number }[]
    ).map((r): [number, number] => [r.hour, round(r.s)]);

    const first = this.db.prepare('SELECT MIN(t) AS t FROM load_points').get() as { t: number | null };
    const iso = (t: number | undefined) => (t ? new Date(t * 1000).toISOString() : null);

    return {
      range: range.key,
      bucketSeconds: size,
      buckets,
      peak: {
        streams: peakStreams?.streams ?? 0,
        streamsAt: iso(peakStreams?.t),
        mbps: round((peakEgress?.egress_kbps ?? 0) / 1000),
        mbpsAt: iso(peakEgress?.t),
        transcodes: totals.mt ?? 0,
      },
      average: { streams: round(totals.s ?? 0), mbps: round((totals.e ?? 0) / 1000) },
      weekly,
      since: iso(first.t ?? undefined),
    };
  }
}
