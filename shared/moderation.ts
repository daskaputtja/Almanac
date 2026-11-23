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
