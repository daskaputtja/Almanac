import type { NodeInfo, NodesResponse } from '../../shared/load.js';
import type { HealthCheck, ServerOverview } from '../../shared/server.js';
import type { Database } from '../db/database.js';
import type { ServerSource } from '../silo/client.js';
import type { SiloNodeDetail, SiloServerStatus, SiloSystemInfo } from '../silo/types.js';

const REFRESH_MS = 60_000;

/**
 * Silo's version, uptime, database health and nodes, plus counts from
 * Almanac's own copy of the catalog and history. Silo is asked once a
 * minute, whatever the number of viewers.
 */
export class ServerOverviewService {
  private status: SiloServerStatus | null = null;
  private nodes: SiloNodeDetail[] | null = null;
  private nodesAt: string | null = null;
  private info: SiloSystemInfo | null = null;
  private checkedAt: string | null = null;
  private problems: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly source: ServerSource,
  ) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    const problems: string[] = [];
    const attempt = async <T,>(what: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };
    const [status, nodes, info] = await Promise.all([
      attempt('Server status', () => this.source.serverStatus()),
      attempt('Nodes', () => this.source.nodeDetails()),
      attempt('Version', () => this.source.systemInfo()),
    ]);
    // Keep the last good answer for anything that failed this time.
    this.status = status ?? this.status;
    this.nodes = nodes ?? this.nodes;
    if (nodes) this.nodesAt = new Date().toISOString();
    this.info = info ?? this.info;
    if (status || nodes || info) this.checkedAt = new Date().toISOString();
    this.problems = problems;
  }

  overview(now = Date.now()): ServerOverview {
    const since = new Date(now - 86_400_000).toISOString();
    const profiles = this.db
      .prepare('SELECT COUNT(DISTINCT user_id || \':\' || profile_id) AS n FROM plays WHERE started_at >= ?')
      .get(since) as { n: number };
    const catalog = this.db
      .prepare(
        `SELECT c.type AS type, COUNT(DISTINCT c.content_id) AS items, COUNT(DISTINCT j.value) AS libraries
         FROM catalog_items c, json_each(c.library_ids) j
         WHERE c.type IN ('movie', 'series') GROUP BY c.type`,
      )
      .all() as { type: string; items: number; libraries: number }[];
    const catalogReady = Boolean(
      (this.db.prepare("SELECT value FROM sync_state WHERE key = 'catalog_full_at'").get() as { value: string | null } | undefined)?.value,
    );
    const movies = catalog.find((c) => c.type === 'movie');
    const shows = catalog.find((c) => c.type === 'series');

    const health = (h: { configured?: boolean; ok?: boolean; latency_ms?: number } | undefined): HealthCheck | null =>
      h && h.configured !== false ? { ok: Boolean(h.ok), latencyMs: typeof h.latency_ms === 'number' ? h.latency_ms : null } : null;
    const enabledNodes = this.nodes?.filter((n) => n.enabled !== false) ?? null;

    return {
      version: this.info?.server_version ?? null,
      startedAt: this.status?.started_at ?? null,
      restartRequired: Boolean(this.status?.restart_required),
      postgres: health(this.status?.health?.postgres),
      redis: health(this.status?.health?.redis),
      nodes: enabledNodes ? { healthy: enabledNodes.filter((n) => n.healthy).length, total: enabledNodes.length } : null,
      profiles24h: profiles.n,
      catalogReady,
      movies: { count: movies?.items ?? 0, libraries: movies?.libraries ?? 0 },
      shows: { count: shows?.items ?? 0, libraries: shows?.libraries ?? 0 },
      checkedAt: this.checkedAt,
      problems: this.problems,
    };
  }

  /** Every node with its health and load, plus how many live streams go out through it. */
  nodeList(streamsByNode: Map<string, number>): NodesResponse {
    const nodes = (this.nodes ?? []).map((n): NodeInfo => {
      const sys = n.resources?.system;
      return {
        id: n.id,
        name: n.name ?? `Node ${n.id}`,
        type: n.type ?? null,
        group: n.group ?? null,
        enabled: n.enabled !== false,
        healthy: Boolean(n.healthy),
        draining: Boolean(n.drain_state && n.drain_state !== 'none'),
        activeJobs: n.active_jobs ?? 0,
        egressMbps: Math.round((n.egress_kbps ?? 0) / 100) / 10,
        cpuPercent: sys?.cpu_pct ?? null,
        cores: sys?.cores ?? null,
        load1: sys?.load1 ?? null,
        memoryUsedGb: sys?.mem_used_mb != null ? Math.round(sys.mem_used_mb / 102.4) / 10 : null,
        memoryTotalGb: sys?.mem_total_mb != null ? Math.round(sys.mem_total_mb / 102.4) / 10 : null,
        streams: streamsByNode.get(n.name ?? '') ?? 0,
        lastHealthCheck: n.last_health_check ?? null,
      };
    });
    nodes.sort((a, b) => b.egressMbps - a.egressMbps || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { nodes, checkedAt: this.nodesAt };
  }
}
