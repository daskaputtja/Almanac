/** Where people watch from, for the map on the Statistics page. */

export interface GeoCountry {
  /** ISO 3166-1 alpha-2, e.g. "GB". */
  code: string;
  plays: number;
  viewers: number;
}

export interface GeoCity {
  country: string;
  city: string;
  region: string | null;
  lat: number;
  lon: number;
  plays: number;
  viewers: number;
}

export interface GeoResponse {
  /** False until the location database has been downloaded. */
  ready: boolean;
  /** When the location data was built, e.g. "2026-06-05". */
  dataDate: string | null;
  countries: GeoCountry[];
  /** Admins only: cities are close to exact locations. Empty for mods. */
  cities: GeoCity[];
  /** Plays from private (home network) addresses. */
  local: number;
  /** Plays whose address hasn't been located (yet, or not in the database). */
  unknown: number;
}

/** Who operates a viewer's network, and whether it's a VPN or data centre rather than a home or mobile connection. */
export interface ViewerNetwork {
  /** The operator's name, e.g. "British Telecommunications PLC" or "Proton AG". Only sent to admins. */
  operator: string | null;
  vpn: boolean;
}
