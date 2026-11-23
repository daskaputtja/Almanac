import type {
  CatalogPageQuery,
  HistoryPageQuery,
  SiloCatalogItem,
  SiloCollection,
  SiloHistoryEntry,
  SiloLibrary,
  SiloNodeDetail,
  SiloNodeSummary,
  SiloProblem,
  SiloServerStatus,
  SiloSystemInfo,
  SiloSession,
  SiloTimeseries,
  SiloUser,
} from './types.js';

export class SiloError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'SiloError';
  }
}

/** Where Almanac gets live sessions from: a real Silo server or the mock. */
export interface SessionSource {
  listSessions(): Promise<SiloSession[]>;
}

/** Where Almanac gets finished plays from. Pages are newest first. */
export interface HistorySource {
  listHistoryPage(query: HistoryPageQuery): Promise<SiloCollection<SiloHistoryEntry>>;
}

/** Where Almanac gets accounts, libraries and the catalog from. */
export interface CatalogSource {
  listUsers(): Promise<SiloUser[]>;
  /** Library names. Throws a 403 SiloError when the key lacks `libraries:read`. */
  listLibraries(): Promise<SiloLibrary[]>;
  listCatalogPage(query: CatalogPageQuery): Promise<SiloCollection<SiloCatalogItem>>;
}

/** Where Almanac gets server health for the Activity page's overview. */
export interface ServerSource {
  serverStatus(): Promise<SiloServerStatus>;
  nodes(): Promise<SiloNodeSummary[]>;
  systemInfo(): Promise<SiloSystemInfo>;
  /** Load samples for the last `hours` hours (Silo keeps about 31 days). */
  timeseries(hours: number): Promise<SiloTimeseries>;
  nodeDetails(): Promise<SiloNodeDetail[]>;
}

const PAGE_SIZE = 200; // Silo's maximum
const MAX_PAGES = 50; // stop runaway paging if a cursor never ends

export class SiloClient implements SessionSource, HistorySource, CatalogSource, ServerSource {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'Almanac',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SiloError(`Could not reach Silo at ${this.baseUrl}: ${reason}`, null);
    }

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const problem = (await res.json()) as SiloProblem;
        detail = problem.detail ?? problem.title ?? detail;
      } catch {
        // Not a problem+json body; keep the status text.
      }
      throw new SiloError(`Silo returned ${res.status} for ${path}: ${detail}`, res.status);
    }

    return (await res.json()) as T;
  }

  /** Every live playback session on the server, following Silo's cursor paging. */
  async listSessions(): Promise<SiloSession[]> {
    const sessions: SiloSession[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.get<SiloCollection<SiloSession>>('/api/v2/admin/sessions', {
        limit: PAGE_SIZE,
        cursor,
      });
      sessions.push(...result.items);
      cursor = result.page?.has_more ? result.page.next_cursor : undefined;
      if (!cursor) break;
    }

    return sessions;
  }

  /**
   * One page of finished plays, newest first. Silo binds each cursor to its
   * query, so the same `endedAfter` must be sent with every page of a walk.
   */
  listHistoryPage(query: HistoryPageQuery): Promise<SiloCollection<SiloHistoryEntry>> {
    return this.get<SiloCollection<SiloHistoryEntry>>('/api/v2/admin/playback-history', {
      limit: query.limit ?? PAGE_SIZE,
      cursor: query.cursor,
      ended_after: query.endedAfter,
    });
  }

  async listUsers(): Promise<SiloUser[]> {
    const users: SiloUser[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 500; page++) {
      const result = await this.get<SiloCollection<SiloUser>>('/api/v2/admin/users', { limit: PAGE_SIZE, cursor });
      // Keep only what Almanac needs; Silo also returns emails and policies.
      for (const u of result.items) {
        users.push({
          id: u.id,
          username: u.username,
          role: u.role,
          enabled: u.enabled,
          is_owner: u.is_owner,
          created_at: u.created_at,
          last_active_at: u.last_active_at,
        });
      }
      cursor = result.page?.has_more ? result.page.next_cursor : undefined;
      if (!cursor) break;
    }
    return users;
  }

  async listLibraries(): Promise<SiloLibrary[]> {
    const result = await this.get<SiloCollection<SiloLibrary> | SiloLibrary[]>('/api/v2/user/libraries');
    const items = Array.isArray(result) ? result : result.items;
    return items.map((l) => ({ id: String(l.id), name: l.name, type: l.type, sort_order: l.sort_order }));
  }

  /** One page of the catalog. Cursors are bound to the filters, so repeat them. */
  listCatalogPage(query: CatalogPageQuery): Promise<SiloCollection<SiloCatalogItem>> {
    return this.get<SiloCollection<SiloCatalogItem>>('/api/v2/admin/catalog/items', {
      limit: query.limit ?? PAGE_SIZE,
      type: query.type,
      added_after: query.addedAfter,
      cursor: query.cursor,
    });
  }

  serverStatus(): Promise<SiloServerStatus> {
    return this.get<SiloServerStatus>('/api/v2/admin/server/status');
  }

  async nodes(): Promise<SiloNodeSummary[]> {
    const result = await this.get<SiloCollection<SiloNodeSummary>>('/api/v2/admin/nodes/summary');
    // The summary also carries detailed resource readings; keep only what we use.
    return result.items.map((n) => ({ id: n.id, name: n.name, enabled: n.enabled, healthy: n.healthy }));
  }

  systemInfo(): Promise<SiloSystemInfo> {
    return this.get<SiloSystemInfo>('/api/v2/system/info');
  }

  timeseries(hours: number): Promise<SiloTimeseries> {
    return this.get<SiloTimeseries>('/api/v2/admin/stats/timeseries', { hours: Math.min(744, Math.max(1, Math.round(hours))) });
  }

  async nodeDetails(): Promise<SiloNodeDetail[]> {
    const result = await this.get<SiloCollection<SiloNodeDetail>>('/api/v2/admin/nodes/summary');
    return result.items.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      group: n.group,
      enabled: n.enabled,
      healthy: n.healthy,
      active_jobs: n.active_jobs,
      max_jobs: n.max_jobs,
      egress_kbps: n.egress_kbps,
      max_bandwidth_kbps: n.max_bandwidth_kbps,
      drain_state: n.drain_state,
      last_health_check: n.last_health_check,
      resources: { system: n.resources?.system && {
        cpu_pct: n.resources.system.cpu_pct,
        cores: n.resources.system.cores,
        load1: n.resources.system.load1,
        mem_used_mb: n.resources.system.mem_used_mb,
        mem_total_mb: n.resources.system.mem_total_mb,
      } },
    }));
  }
}
