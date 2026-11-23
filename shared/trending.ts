export interface TrendingItem {
  key: string;
  kind: 'movie' | 'show';
  title: string;
  year: number | null;
  posterUrl: string | null;
  /** Different people who watched it in the period. */
  viewers: number;
  plays: number;
  /** Viewers in the period before, for "rising". */
  previousViewers: number;
  /** Change in viewers versus the period before; null when it's new. */
  changePercent: number | null;
  /** Binging: average episodes each viewer watched. */
  episodesPerViewer?: number;
}

export interface TrendingResponse {
  rising: TrendingItem[];
  popular: TrendingItem[];
  binging: TrendingItem[];
}
