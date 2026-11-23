import type { HistoryPageQuery, SiloCollection, SiloHistoryEntry, SiloProblem, SiloSession } from './types.js';

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

const PAGE_SIZE = 200; // Silo's maximum
const MAX_PAGES = 50; // stop runaway paging if a cursor never ends

export class SiloClient implements SessionSource, HistorySource {
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
}
