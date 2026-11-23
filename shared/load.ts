/** Server load over time, for the Server page. */

/** `[unix seconds, avg streams, max streams, avg transcodes, max transcodes, avg Mbps, max Mbps]` */
export type LoadBucket = [number, number, number, number, number, number, number];

export interface LoadRange {
  key: '24h' | '7d' | '30d' | '90d' | '365d';
  label: string;
  hours: number;
}

export const LOAD_RANGES: LoadRange[] = [
  { key: '24h', label: '24 hours', hours: 24 },
  { key: '7d', label: '7 days', hours: 168 },
  { key: '30d', label: '30 days', hours: 720 },
  { key: '90d', label: '90 days', hours: 2160 },
  { key: '365d', label: '1 year', hours: 8760 },
];

export interface LoadResponse {
  range: LoadRange['key'];
  bucketSeconds: number;
  buckets: LoadBucket[];
  peak: { streams: number; streamsAt: string | null; mbps: number; mbpsAt: string | null; transcodes: number };
  average: { streams: number; mbps: number };
  /** Average streams per UTC hour over the last 4 weeks: `[unix seconds of the hour, avg streams]`. */
  weekly: [number, number][];
  /** When the history Almanac holds begins. */
  since: string | null;
}

export interface NodeInfo {
  id: string;
  name: string;
  type: string | null;
  group: string | null;
  enabled: boolean;
  healthy: boolean;
  draining: boolean;
  activeJobs: number;
  egressMbps: number;
  cpuPercent: number | null;
  cores: number | null;
  load1: number | null;
  memoryUsedGb: number | null;
  memoryTotalGb: number | null;
  /** Live streams Almanac sees going out through this node. */
  streams: number;
  lastHealthCheck: string | null;
}

export interface NodesResponse {
  nodes: NodeInfo[];
  checkedAt: string | null;
}
