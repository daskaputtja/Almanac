/** Is the server going to run out of room? Evening peaks, their trend, and the limits the owner sets. */

export type CapacityMetric = 'streams' | 'mbps' | 'transcodes';

export const CAPACITY_METRICS: { key: CapacityMetric; label: string; unit: string; limitLabel: string; limitHelp: string }[] = [
  {
    key: 'streams',
    label: 'Streams at once',
    unit: 'streams',
    limitLabel: 'Most streams the server handles well',
    limitHelp: 'The number of streams at once where things start to struggle, if you know it.',
  },
  {
    key: 'mbps',
    label: 'Upload bandwidth',
    unit: 'Mbps',
    limitLabel: 'Upload bandwidth, in Mbps',
    limitHelp: 'Your servers’ total upload speed (for example 1000 for a 1 Gbps line).',
  },
  {
    key: 'transcodes',
    label: 'Transcodes at once',
    unit: 'transcodes',
    limitLabel: 'Most transcodes at once',
    limitHelp: 'How many conversions your nodes can run at the same time before they slow down.',
  },
];

/** ok: plenty of room · watch: full within 90 days, or busy nights above 80% · tight: within 30 days, or above 95%. */
export type CapacityStatus = 'ok' | 'watch' | 'tight' | 'unknown';

export interface CapacityMetricReport {
  metric: CapacityMetric;
  /** The busiest evening in the last 7 days. */
  busiest: { value: number; on: string } | null;
  /** A typical evening peak now, from the trend line. */
  typical: number | null;
  /** How fast the typical peak is changing, as a share per 30 days (0.2 = 20% more a month). Null without enough history. */
  growthPerMonth: number | null;
  limit: number | null;
  /** Busiest evening as a share of the limit. */
  used: number | null;
  /** When busy evenings are expected to reach the limit, if they are within a year. */
  fullBy: string | null;
  status: CapacityStatus;
  /** `[day (unix ms), peak]`, one point per day, for the chart. */
  days: [number, number][];
  /** The trend line, at the first and last day shown and at the forecast's end. */
  trend: [number, number][];
}

export interface CapacityReport {
  /** Days of history used (up to 8 weeks). The forecast needs at least 21. */
  historyDays: number;
  minimumDays: number;
  metrics: CapacityMetricReport[];
  limits: CapacityLimits;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface CapacityLimits {
  streams: number | null;
  mbps: number | null;
  transcodes: number | null;
}
