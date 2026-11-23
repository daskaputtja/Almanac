/** The transcode report on the Server page. */

export interface TranscodeSuggestion {
  /** How much it matters: share of transcodes it would avoid. */
  impact: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
}

export interface TranscodeReport {
  days: number;
  /** From play history (complete for the period). */
  plays: { total: number; direct: number; directStream: number; remux: number; transcode: number };
  players: { name: string; platform: string | null; plays: number; transcodes: number; rate: number }[];
  /** From live streams Almanac has watched since `observedSince`. */
  observedSince: string | null;
  observed: number;
  /** Observed streams that weren't direct play. Suggestions from reasons need enough of these. */
  convertedObserved: number;
  /** How many converted streams are needed before reason- and file-based suggestions appear. */
  minimumForSuggestions: number;
  reasons: { reason: string; streams: number; share: number }[];
  sources: { video: string; streams: number; transcodes: number; rate: number }[];
  files: {
    fileId: string;
    title: string;
    transcodes: number;
    users: number;
    source: string;
    reasons: string[];
  }[];
  suggestions: TranscodeSuggestion[];
}
