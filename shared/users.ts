export interface UserSummary {
  id: string;
  name: string;
  /** The account's email in Silo, to help recognise people. Null if unknown. */
  email: string | null;
  /** From Silo; null when the account no longer exists there. */
  role: string | null;
  enabled: boolean | null;
  isOwner: boolean;
  /** False when the account has been deleted in Silo but still has plays. */
  inSilo: boolean;
  createdAt: string | null;
  /** Silo's last-active time for the account (any activity, not only playback). */
  lastActiveAt: string | null;
  lastPlayedAt: string | null;
  lastPlayed: { title: string; seriesTitle: string | null; mediaType: string } | null;
  plays: number;
  plays30Days: number;
  watchedSeconds: number;
  topPlatform: string | null;
  /** Share of plays that were direct play, 0–100. Null with no plays. */
  directPlayPercent: number | null;
}

export interface UsersResponse {
  users: UserSummary[];
}

export interface UserDetail extends UserSummary {
  firstPlayedAt: string | null;
  profiles: { name: string; plays: number; lastPlayedAt: string }[];
  devices: { player: string; platform: string | null; plays: number; lastPlayedAt: string }[];
  addresses: { ip: string; plays: number; firstSeenAt: string; lastSeenAt: string }[];
}
