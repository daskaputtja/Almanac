/** Account flags: behaviour worth a moderator's look. */

export type FlagKind =
  /** Streaming from several different networks at the same moment. */
  | 'concurrent_networks'
  /** Many different networks in a week. */
  | 'many_networks'
  /** Many different devices in a week. */
  | 'many_devices'
  /** Playing for a very long time without a break. */
  | 'nonstop'
  /** Playing most of every day. */
  | 'heavy_daily'
  /** Title after title played start to finish with no pauses. */
  | 'back_to_back';

export type FlagGroup = 'sharing' | 'nonstop' | 'ripping';

export type Severity = 'high' | 'medium' | 'low';

export const FLAG_GROUP: Record<FlagKind, FlagGroup> = {
  concurrent_networks: 'sharing',
  many_networks: 'sharing',
  many_devices: 'sharing',
  nonstop: 'nonstop',
  heavy_daily: 'nonstop',
  back_to_back: 'ripping',
};

export const GROUP_LABELS: Record<FlagGroup, { title: string; meaning: string }> = {
  sharing: {
    title: 'Possible account sharing',
    meaning: 'Several people in different places may be using this account.',
  },
  nonstop: {
    title: 'Non-stop playback',
    meaning: 'Could be restreaming to others, or a TV left playing.',
  },
  ripping: {
    title: 'Possible ripping',
    meaning: 'Playing title after title start to finish without pausing is how libraries get recorded or downloaded.',
  },
};

export type FlagStatus = 'open' | 'reviewed';

export interface ModerationFlag {
  /** `${userId}:${kind}` */
  id: string;
  userId: string;
  username: string;
  kind: FlagKind;
  group: FlagGroup;
  severity: Severity;
  headline: string;
  details: string[];
  /** Extra detail for admins only, such as which networks. Empty for mods. */
  adminDetails: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** False once the behaviour is no longer seen in the last 7 days. */
  active: boolean;
  status: FlagStatus;
  review: { by: string; at: string; note: string | null } | null;
}

export interface FlagsResponse {
  flags: ModerationFlag[];
  /** When the checks last ran. */
  checkedAt: string | null;
  counts: { open: number; openHigh: number };
}

export interface UserNote {
  id: number;
  userId: string;
  authorName: string;
  /** True if the signed-in account may edit or delete this note. */
  canEdit: boolean;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TagsResponse {
  /** Tags for every user that has any, by Silo user ID. */
  byUser: Record<string, string[]>;
  /** Every tag in use, with how many users have it, most used first. */
  all: { tag: string; users: number }[];
}

/** Offered when adding a tag; anything else can be typed. */
export const SUGGESTED_TAGS = ['VIP', 'Family', 'Friend', 'Trial', 'Warned', 'Watch closely', 'Sharing confirmed'];

// ---------------------------------------------------------------------------
// Adjustable thresholds for the account checks.

export type Level = 'low' | 'medium' | 'high';

export interface ThresholdLevels {
  enabled: boolean;
  low?: number;
  medium?: number;
  high?: number;
}

export type ThresholdKey =
  | 'concurrentNetworks'
  | 'networksInWindow'
  | 'devicesInWindow'
  | 'nonstopHours'
  | 'dailyHours'
  | 'backToBack'
  | 'backToBackMovies';

export type FlagThresholds = Record<ThresholdKey, ThresholdLevels>;

/**
 * Chosen from a real server's history (about 450 active users): each check
 * flags roughly the top 1% of accounts or fewer, and normal heavy viewers
 * (families, bingers, phones changing IP) stay under them.
 */
export const DEFAULT_THRESHOLDS: FlagThresholds = {
  concurrentNetworks: { enabled: true, medium: 3, high: 4 },
  networksInWindow: { enabled: true, low: 10, medium: 14 },
  devicesInWindow: { enabled: true, low: 7, medium: 10 },
  nonstopHours: { enabled: true, medium: 24, high: 48 },
  dailyHours: { enabled: true, medium: 12, high: 18 },
  backToBack: { enabled: true, medium: 20, high: 40 },
  backToBackMovies: { enabled: true, medium: 5, high: 8 },
};

export interface ThresholdInfo {
  group: FlagGroup;
  label: string;
  description: string;
  /** Shown after the number, e.g. "networks". */
  unit: string;
  levels: Level[];
  min: number;
  max: number;
}

export const THRESHOLD_INFO: Record<ThresholdKey, ThresholdInfo> = {
  concurrentNetworks: {
    group: 'sharing',
    label: 'Networks at the same time',
    description: 'Different networks streaming from the account at the same moment. A phone and a home TV make 2.',
    unit: 'networks',
    levels: ['medium', 'high'],
    min: 2,
    max: 20,
  },
  networksInWindow: {
    group: 'sharing',
    label: 'Networks in a week',
    description: 'Different networks used over 7 days. Most people use 2 to 5.',
    unit: 'networks',
    levels: ['low', 'medium'],
    min: 2,
    max: 100,
  },
  devicesInWindow: {
    group: 'sharing',
    label: 'Devices in a week',
    description: 'Different devices used over 7 days. Most people use up to 4.',
    unit: 'devices',
    levels: ['low', 'medium'],
    min: 2,
    max: 100,
  },
  nonstopHours: {
    group: 'nonstop',
    label: 'Hours without a break',
    description: 'Longest stretch of playback with no gap over 10 minutes.',
    unit: 'hours',
    levels: ['medium', 'high'],
    min: 4,
    max: 168,
  },
  dailyHours: {
    group: 'nonstop',
    label: 'Hours a day on average',
    description: 'Average playback per day over 7 days. Most people average under 2 hours.',
    unit: 'hours a day',
    levels: ['medium', 'high'],
    min: 2,
    max: 24,
  },
  backToBack: {
    group: 'ripping',
    label: 'Titles back to back',
    description: 'Titles played to the end one after another, with under a minute of pausing in each and under 3 minutes between them.',
    unit: 'titles',
    levels: ['medium', 'high'],
    min: 3,
    max: 500,
  },
  backToBackMovies: {
    group: 'ripping',
    label: 'Movies back to back',
    description: 'The same, counting only movies. Finishing them much faster than their running time always counts as serious.',
    unit: 'movies',
    levels: ['medium', 'high'],
    min: 2,
    max: 100,
  },
};

export const LEVEL_LABELS: Record<Level, string> = { low: 'Minor', medium: 'Worth a look', high: 'Serious' };

/**
 * Check thresholds sent from the dashboard. Returns the cleaned thresholds,
 * or a readable problem. Missing checks keep their defaults.
 */
export function validateThresholds(input: unknown): FlagThresholds | string {
  if (!input || typeof input !== 'object') return 'Send the thresholds as an object.';
  const source = input as Partial<Record<ThresholdKey, Partial<ThresholdLevels>>>;
  const result = {} as FlagThresholds;
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as ThresholdKey[]) {
    const info = THRESHOLD_INFO[key];
    const given = source[key] ?? {};
    const levels: ThresholdLevels = { enabled: given.enabled ?? DEFAULT_THRESHOLDS[key].enabled };
    let previous = -Infinity;
    for (const level of info.levels) {
      const value = given[level] ?? DEFAULT_THRESHOLDS[key][level];
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${info.label}: enter a number for “${LEVEL_LABELS[level]}”.`;
      if (value < info.min || value > info.max) return `${info.label}: “${LEVEL_LABELS[level]}” must be between ${info.min} and ${info.max}.`;
      if (value <= previous) return `${info.label}: each level must be higher than the one before.`;
      levels[level] = Math.round(value * 10) / 10;
      previous = value;
    }
    result[key] = levels;
  }
  return result;
}

/** Merge stored thresholds over the defaults, so checks added later get their defaults. */
export function withDefaults(stored: unknown): FlagThresholds {
  const valid = stored ? validateThresholds(stored) : DEFAULT_THRESHOLDS;
  return typeof valid === 'string' ? DEFAULT_THRESHOLDS : valid;
}

export interface ThresholdsResponse {
  thresholds: FlagThresholds;
  defaults: FlagThresholds;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Which flag each threshold feeds. Both back-to-back checks feed one flag. */
export const THRESHOLD_KIND: Record<ThresholdKey, FlagKind> = {
  concurrentNetworks: 'concurrent_networks',
  networksInWindow: 'many_networks',
  devicesInWindow: 'many_devices',
  nonstopHours: 'nonstop',
  dailyHours: 'heavy_daily',
  backToBack: 'back_to_back',
  backToBackMovies: 'back_to_back',
};

export interface PreviewCounts {
  /** Different accounts with at least one flag. */
  accounts: number;
  byKind: Record<FlagKind, Record<Level, number>>;
}

/** How many accounts would be flagged now, and with the thresholds being edited. */
export interface FlagPreview {
  current: PreviewCounts;
  proposed: PreviewCounts;
}
