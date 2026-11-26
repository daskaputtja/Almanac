/** Shared with the phone app: what the server says about itself, and notification settings. */

/** GET /api/app/info, open to anyone: lets the app check an address really is an Almanac. */
export interface AppServerInfo {
  app: 'almanac';
  /** Bumped when the app API changes in a way older apps need to know about. */
  apiVersion: number;
  /** The Silo server it watches, for display ("Watching silo.example.com"). */
  siloHost: string | null;
}

export const APP_API_VERSION = 1;

/** Which push notifications one phone wants. */
export interface PushPreferences {
  /** Account flags at this severity and above, or none. */
  flags: 'off' | 'high' | 'medium' | 'low';
  /** Suspension requests to review (admins) and decisions on your own requests (mods). */
  suspensions: boolean;
  /** Streams dropping much more than usual, and servers going down or coming back. */
  serverAlerts: boolean;
  /** Include usernames and details; off shows only "New account flag" and so on. */
  details: boolean;
}

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = { flags: 'medium', suspensions: true, serverAlerts: true, details: true };

/** A recent alert, for apps that ask for them (the desktop app) instead of receiving pushes. */
export interface AppEvent {
  id: number;
  at: string;
  kind: 'flag' | 'suspension_request' | 'suspension_decided' | 'server';
  /** For flags: low, medium or high. */
  severity: string | null;
  title: string;
  body: string;
  /** Where to go in Almanac, e.g. "/users/42". */
  path: string | null;
}

export interface AppEventsResponse {
  events: AppEvent[];
  /** Pass this back as `after` next time. */
  latest: number;
}
