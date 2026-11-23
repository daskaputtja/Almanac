import { describe, expect, it } from 'vitest';
import type { ActivityStream } from '../shared/activity.js';
import { toActivityStream } from '../server/activity/map.js';
import { openDatabase } from '../server/db/database.js';
import { HistoryStore } from '../server/history/store.js';
import { LoadHistory } from '../server/load/load.js';
import { ServerOverviewService } from '../server/server/overview.js';
import { MockHistorySource, MockServerSource, MockSessionSource } from '../server/silo/mock.js';
import { TranscodeDoctor } from '../server/transcodes/doctor.js';

describe('LoadHistory', () => {
  it('backfills from Silo on first sync, then keeps the finest samples', async () => {
    const db = openDatabase(':memory:');
    const history = new LoadHistory(db, new MockServerSource(), () => {});
    await history.sync();
    const day = history.load('24h');
    expect(day.bucketSeconds).toBe(300);
    expect(day.buckets.length).toBeGreaterThan(200);
    expect(day.peak.streams).toBeGreaterThan(day.average.streams);
    expect(day.peak.streamsAt).not.toBeNull();
    expect(day.weekly.length).toBeGreaterThan(24);
    const month = history.load('30d');
    expect(month.bucketSeconds).toBe(3 * 3600);
    expect(month.buckets.length).toBeGreaterThan(day.buckets.length / 10);
    expect(Date.parse(month.since!)).toBeLessThan(Date.now() - 25 * 86_400_000);
  });

  it('doesn’t let a coarse sample overwrite a fine one', () => {
    const db = openDatabase(':memory:');
    const history = new LoadHistory(db, new MockServerSource(), () => {});
    const t = '2026-06-01T12:00:00.000Z';
    history.store([{ t, streams: 10 }], 300);
    history.store([{ t, streams: 99 }], 7200);
    const row = db.prepare('SELECT streams, resolution FROM load_points').get() as { streams: number; resolution: number };
    expect(row).toEqual({ streams: 10, resolution: 300 });
    history.store([{ t, streams: 12 }], 300);
    expect((db.prepare('SELECT streams FROM load_points').get() as { streams: number }).streams).toBe(12);
  });
});

describe('nodes', () => {
  it('lists nodes busiest first, with live streams per node', async () => {
    const db = openDatabase(':memory:');
    const overview = new ServerOverviewService(db, new MockServerSource());
    await overview.refresh();
    const { nodes, checkedAt } = overview.nodeList(new Map([['node-1', 3]]));
    expect(checkedAt).not.toBeNull();
    expect(nodes.map((n) => n.name)).toEqual(['node-1', 'node-2', 'node-4', 'node-3']);
    expect(nodes[0]).toMatchObject({ streams: 3, healthy: true, egressMbps: 42, cpuPercent: 12, memoryTotalGb: 31.3, type: 'proxy' });
    expect(overview.overview().nodes).toEqual({ healthy: 4, total: 4 });
  });

  it('records which node a stream goes through', async () => {
    const [session] = await new MockSessionSource().listSessions();
    expect(toActivityStream(session!).egressNode).toBe('node-1');
  });
});

describe('TranscodeDoctor', () => {
  async function streams(): Promise<ActivityStream[]> {
    return (await new MockSessionSource().listSessions()).map(toActivityStream);
  }

  it('records live streams and keeps every reason seen', async () => {
    const db = openDatabase(':memory:');
    const doctor = new TranscodeDoctor(db);
    const live = await streams();
    const now = Date.now();
    doctor.record(live, now);
    const transcode = live.find((s) => s.playback.method === 'transcode')!;
    // Later the same stream also reports buffering.
    doctor.record([{ ...transcode, playback: { ...transcode.playback, reasons: ['buffering'] } }], now + 60_000);
    const row = db.prepare('SELECT reasons FROM stream_observations WHERE session_id = ?').get(transcode.id) as { reasons: string };
    expect(JSON.parse(row.reasons).sort()).toEqual([...transcode.playback.reasons, 'buffering'].sort());
    expect((db.prepare('SELECT COUNT(*) AS n FROM stream_observations').get() as { n: number }).n).toBe(live.length);
  });

  it('doesn’t rewrite a stream more often than every 30 seconds', async () => {
    const db = openDatabase(':memory:');
    const doctor = new TranscodeDoctor(db);
    const live = await streams();
    doctor.record(live, 1_000_000);
    doctor.record(live.map((s) => ({ ...s, playback: { ...s.playback, reasons: ['buffering'] } })), 1_010_000);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM stream_observations WHERE reasons LIKE '%buffering%'").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('reports rates, reasons, files and suggestions', async () => {
    const db = openDatabase(':memory:');
    new HistoryStore(db).upsert((await new MockHistorySource().listHistoryPage({ limit: 600 })).items);
    const doctor = new TranscodeDoctor(db);
    const live = await streams();
    // Many viewers burning in subtitles on the same file.
    const burn = live.find((s) => s.playback.reasons.includes('subtitle_burn_in'))!;
    const copies = Array.from({ length: 30 }, (_, i) => ({ ...burn, id: `copy-${i}`, user: { ...burn.user, id: `u${i % 7}` } }));
    doctor.record([...live, ...copies]);

    const report = doctor.report(30);
    expect(report.plays.total).toBeGreaterThan(0);
    expect(report.plays.transcode).toBeGreaterThan(0);
    expect(report.players[0]!.transcodes).toBeGreaterThanOrEqual(report.players[1]?.transcodes ?? 0);
    expect(report.reasons[0]).toMatchObject({ reason: 'subtitle_burn_in' });
    expect(report.files[0]).toMatchObject({ transcodes: 31, users: 8, reasons: ['subtitle_burn_in'] }) // 7 copies' viewers plus the original;
    expect(report.suggestions.some((s) => s.title === 'Subtitles are forcing transcodes' && /PGS/.test(s.detail))).toBe(true);
    expect(report.observedSince).not.toBeNull();
  });
});
