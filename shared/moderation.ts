import type { SuspensionRequest } from './suspensions.js';

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
  /** Hours of title after title watched start to finish with no pauses. */
  | 'back_to_back'
  /** A lot of offline downloads in a week. */
  | 'heavy_downloads'
  /** Many devices registered to the account and in use. */
  | 'many_registered_devices'
  /** Played in two places too far apart to travel between in the time. */
  | 'impossible_travel'
  /** Many different titles opened in a day with almost nothing watched: a tool working through the library. */
  | 'bulk_opening';

export type FlagGroup = 'sharing' | 'nonstop' | 'ripping';

export type Severity = 'high' | 'medium' | 'low';

export const FLAG_GROUP: Record<FlagKind, FlagGroup> = {
  concurrent_networks: 'sharing',
  many_networks: 'sharing',
  many_devices: 'sharing',
  nonstop: 'nonstop',
  heavy_daily: 'nonstop',
  back_to_back: 'ripping',
  heavy_downloads: 'ripping',
  many_registered_devices: 'sharing',
  impossible_travel: 'sharing',
  bulk_opening: 'ripping',
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
    meaning:
      'Downloading a lot for offline viewing makes full copies. Hours of title after title with no pauses can be screen recording, though it’s also how people binge or fall asleep with the TV on.',
  },
};

export type FlagStatus = 'open' | 'reviewed';

export interface ModerationFlag {
  /** `${userId}:${kind}` */
  id: string;
  userId: string;
  username: string;
  email: string | null;
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
  /** The account has an exception for this kind of flag (so this one is above what it allows). */
  exception: { upTo: ExceptionLevel; reason: string; addedBy: string; expiresAt: string | null } | null;
}

// ---------------------------------------------------------------------------
// Exceptions: accounts allowed to do something that would otherwise be flagged.

/** medium: minor and “worth a look” flags are hidden, serious ones still show. high: every flag of the kind is hidden. */
export type ExceptionLevel = 'medium' | 'high';

export const EXCEPTION_LEVELS: { value: ExceptionLevel; label: string; detail: string }[] = [
  { value: 'medium', label: 'Hide minor and “Worth a look” flags', detail: 'Serious flags of this kind still show.' },
  { value: 'high', label: 'Hide every flag of this kind', detail: 'Nothing of this kind is flagged until the exception ends.' },
];

/** Is this flag of a level its account's exception hides (so it's gone quiet because of the exception)? */
export function coveredByException(flag: Pick<ModerationFlag, 'severity' | 'exception'>): boolean {
  const rank = { low: 1, medium: 2, high: 3 } as const;
  return Boolean(flag.exception && rank[flag.severity] <= rank[flag.exception.upTo]);
}

export const EXCEPTION_LENGTHS: { days: number | null; label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
  { days: null, label: 'Until removed' },
];

export interface FlagException {
  userId: string;
  username: string;
  email: string | null;
  group: FlagGroup;
  upTo: ExceptionLevel;
  reason: string;
  addedBy: string;
  addedAt: string;
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// The case file: everything about one account's moderation history on one page.

export interface CaseEvent {
  at: string;
  kind: 'flag' | 'note';
  title: string;
  detail: string | null;
  by: string | null;
  severity: Severity | null;
}

export interface CaseFile {
  user: {
    id: string;
    username: string;
    email: string | null;
    enabled: boolean | null;
    inSilo: boolean;
    createdAt: string | null;
    lastActiveAt: string | null;
    tags: string[];
  };
  summary: {
    openFlags: number;
    flagsEver: number;
    notes: number;
    suspensions: number;
    pendingRequest: boolean;
    exceptions: number;
    plays30Days: number;
    downloads30Days: number;
    lastPlayedAt: string | null;
  };
  flags: ModerationFlag[];
  exceptions: FlagException[];
  /** Suspension requests, newest first (the same shape as the suspensions API). */
  suspensions: SuspensionRequest[];
  /** Flags appearing and every note (reviews, suspensions and exceptions write notes too), newest first. */
  timeline: CaseEvent[];
}

export interface FlagsResponse {
  flags: ModerationFlag[];
  /** When the checks last ran. */
  checkedAt: string | null;
  /** pendingSuspensions: suspension requests waiting for an admin (added by the route). */
  counts: { open: number; openHigh: number; pendingSuspensions?: number };
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
  | 'backToBackHours'
  | 'devicesRegistered'
  | 'travelDays'
  | 'downloadsInWindow'
  | 'downloadGbInWindow'
  | 'titlesOpenedPerDay';

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
  backToBackHours: { enabled: true, low: 8, medium: 12 },
  devicesRegistered: { enabled: true, low: 15, medium: 25 },
  travelDays: { enabled: true, low: 4, medium: 6 },
  downloadsInWindow: { enabled: true, medium: 40, high: 80 },
  downloadGbInWindow: { enabled: true, medium: 200, high: 400 },
  titlesOpenedPerDay: { enabled: true, low: 40, medium: 60, high: 150 },
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
  backToBackHours: {
    group: 'ripping',
    label: 'Hours back to back',
    description:
      'Hours of titles watched start to finish one after another, with under a minute of pausing in each and under 3 minutes between them. Titles skipped to the end don’t count. Never more than “Worth a look” on its own.',
    unit: 'hours',
    levels: ['low', 'medium'],
    min: 1,
    max: 168,
  },
  devicesRegistered: {
    group: 'sharing',
    label: 'Devices signed in',
    description: 'Devices signed in to the account in Silo and used in the last 30 days, whether or not they played anything. Most accounts have under 10.',
    unit: 'devices',
    levels: ['low', 'medium'],
    min: 2,
    max: 500,
  },
  travelDays: {
    group: 'sharing',
    label: 'Days with impossible travel',
    description:
      'Days in the week when two different devices played over 300 miles apart, closer together in time than anyone could travel (including at the same moment). A VPN can cause it once in a while; it happening day after day usually means two households.',
    unit: 'days',
    levels: ['low', 'medium'],
    min: 1,
    max: 7,
  },
  downloadsInWindow: {
    group: 'ripping',
    label: 'Offline downloads in a week',
    description: 'Movies and episodes downloaded to devices for offline viewing over 7 days, including ones since deleted. Downloads are full copies of the file.',
    unit: 'downloads',
    levels: ['medium', 'high'],
    min: 2,
    max: 2000,
  },
  titlesOpenedPerDay: {
    group: 'ripping',
    label: 'Titles opened but not watched in a day',
    description:
      'Different movies and shows started within 24 hours and left with under 2 minutes watched (a show’s episodes count once). People skimming rarely reach 20; a tool scanning or copying the library opens hundreds.',
    unit: 'titles',
    levels: ['low', 'medium', 'high'],
    min: 5,
    max: 10000,
  },
  downloadGbInWindow: {
    group: 'ripping',
    label: 'Offline download size in a week',
    description: 'Total size of those downloads. A 4K movie is often 40 to 80 GB.',
    unit: 'GB',
    levels: ['medium', 'high'],
    min: 1,
    max: 100000,
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
  backToBackHours: 'back_to_back',
  devicesRegistered: 'many_registered_devices',
  travelDays: 'impossible_travel',
  downloadsInWindow: 'heavy_downloads',
  downloadGbInWindow: 'heavy_downloads',
  titlesOpenedPerDay: 'bulk_opening',
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
