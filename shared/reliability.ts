/** How reliably streams play: from Silo's session counts and Almanac's own history. */

export const RELIABILITY_RANGES = {
  '24h': { label: '24 hours', hours: 24, bucketHours: 1 },
  '7d': { label: '7 days', hours: 168, bucketHours: 24 },
  '30d': { label: '30 days', hours: 720, bucketHours: 24 },
} as const;

export type ReliabilityRange = keyof typeof RELIABILITY_RANGES;

/** A stream "dropped" when Silo stopped hearing from the player mid-stream (crash, freeze, lost connection, phone locked). */
export interface ReliabilityCounts {
  plays: number;
  dropped: number;
  /** Stopped within 10 seconds of starting: often a stream that wouldn't start, sometimes just channel-surfing. */
  quickStops: number;
}

export interface ReliabilityGroup extends ReliabilityCounts {
  key: string;
  label: string;
  platform: string | null;
}

export interface ReliabilityResponse {
  range: ReliabilityRange;
  from: string;
  to: string;
  /** From Silo. Null if Silo couldn't be asked. */
  silo: {
    sessionsStarted: number;
    transcodeStarts: number;
    /** Share of finished sessions watched to the end (0 to 1). */
    watchedToEnd: number | null;
    profiles: number;
  } | null;
  totals: ReliabilityCounts;
  /** The same rates over the 4 weeks before this range, for comparison. */
  typical: { droppedRate: number | null; quickStopRate: number | null };
  /** [bucket start (ms), plays, dropped, quickStops] */
  buckets: [number, number, number, number][];
  bucketHours: number;
  players: ReliabilityGroup[];
  methods: ReliabilityGroup[];
}

/** Which new flags are posted to the staff channel: none, or this severity and above. */
export type FlagAlertLevel = 'off' | 'high' | 'medium' | 'low';

export const FLAG_ALERT_LEVELS: { value: FlagAlertLevel; label: string }[] = [
  { value: 'high', label: 'Serious flags' },
  { value: 'medium', label: 'Worth a look and serious' },
  { value: 'low', label: 'Every flag, even minor ones' },
  { value: 'off', label: 'No flags' },
];

export interface StaffAlertsSettings {
  /** The staff webhook with its secret hidden, or null if none is set. */
  webhookHint: string | null;
  reliability: boolean;
  flagLevel: FlagAlertLevel;
  lastAlertAt: string | null;
  alerting: boolean;
}
