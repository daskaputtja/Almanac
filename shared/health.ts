/** How playback is going for each viewer: streams dropping, streams that won't start, and constant transcoding. */

export const HEALTH_DAYS = 30;

export type HealthIssueKind = 'drops' | 'slowStarts' | 'transcoding';

export interface HealthIssue {
  kind: HealthIssueKind;
  severity: 'high' | 'medium' | 'low';
  /** One line, e.g. "9 of 40 streams dropped (23%; usually 4%)". */
  headline: string;
  /** What's behind it and what might help, in plain words. */
  advice: string[];
}

export interface PlayerHealth {
  label: string;
  platform: string | null;
  plays: number;
  dropped: number;
  quickStops: number;
  transcodes: number;
}

export interface UserHealth {
  userId: string;
  username: string;
  email: string | null;
  plays: number;
  dropped: number;
  quickStops: number;
  transcodes: number;
  /** Why their converted streams were converted (from streams Almanac saw live). */
  reasons: { reason: string; label: string; streams: number }[];
  players: PlayerHealth[];
  issues: HealthIssue[];
}

/** Everyone's rates over the same days, to compare with. */
export interface HealthBaseline {
  plays: number;
  droppedRate: number;
  quickStopRate: number;
  transcodeRate: number;
}

export interface HealthOverview {
  days: number;
  baseline: HealthBaseline;
  /** Viewers with at least one issue, worst first. */
  users: UserHealth[];
  /** Viewers with enough plays to judge. */
  checked: number;
}

/** A user's own playback health, for their page. Null when they've hardly played anything. */
export interface UserHealthResponse {
  days: number;
  baseline: HealthBaseline;
  user: UserHealth;
  /** False when there are too few plays to say much. */
  enoughPlays: boolean;
}
