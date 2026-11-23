/** The server overview row at the top of the Activity page. */

export interface HealthCheck {
  ok: boolean;
  latencyMs: number | null;
}

export interface ServerOverview {
  /** Silo's build ID, e.g. "5641447d". */
  version: string | null;
  /** When Silo last started, for the uptime. */
  startedAt: string | null;
  restartRequired: boolean;
  postgres: HealthCheck | null;
  redis: HealthCheck | null;
  nodes: { healthy: number; total: number } | null;
  /** Profiles that started playing something in the last 24 hours. */
  profiles24h: number;
  movies: { count: number; libraries: number };
  shows: { count: number; libraries: number };
  /** When Silo last answered; null if it never has. */
  checkedAt: string | null;
  /** Problems reading parts of the overview, e.g. a missing API key scope. */
  problems: string[];
}
