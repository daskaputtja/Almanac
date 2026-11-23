export interface LibrarySummary {
  id: string;
  /** Silo's name, or "Library 9" when the API key can't read names. */
  name: string;
  /** `movies` or `series`, from Silo or worked out from the items. */
  type: string | null;
  movies: number;
  shows: number;
  /** Movies, shows and episodes added in the last 7 days. */
  addedLastWeek: number;
  /** Total plays from this library in the last 30 days. */
  playsLast30Days: number;
}

export interface CatalogStatus {
  /** True once the first full copy of movies and shows has finished. */
  ready: boolean;
  lastFullSyncAt: string | null;
  lastRecentSyncAt: string | null;
  /** False when the Silo API key lacks `libraries:read`, so names are unknown. */
  libraryNamesAvailable: boolean;
  lastError: string | null;
}

export interface LibrariesResponse {
  libraries: LibrarySummary[];
  totals: { movies: number; shows: number };
  status: CatalogStatus;
}

/** One card in the recently added feed: a movie, or a show with its new episodes. */
export interface RecentlyAddedItem {
  id: string;
  kind: 'movie' | 'show' | 'episodes';
  title: string;
  year: number | null;
  posterUrl: string | null;
  addedAt: string;
  libraryIds: string[];
  /** True when the show itself is new to the server, not just new episodes. */
  isNewShow?: boolean;
  /** For shows: how many episodes were added and a short description like "S2 E4–E7". */
  episodeCount?: number;
  episodeRange?: string;
  resolution: string | null;
  dynamicRange: string | null;
  ratingImdb: number | null;
  genres: string[];
}

export interface RecentlyAddedResponse {
  items: RecentlyAddedItem[];
}
