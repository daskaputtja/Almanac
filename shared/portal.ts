/** The API your billing portal calls (Almanac → portal requests are in shared/suspensions.ts). */

import type { FlagAlertLevel } from './reliability.js';

export const PORTAL_API_VERSION = 1;

/** Settings → Billing portal: the key the portal uses to call Almanac. */
export interface PortalApiSettings {
  /** A key exists. It's only shown once, when it's made. */
  keySet: boolean;
  /** The key's last four characters, to tell keys apart. */
  keyHint: string | null;
  createdBy: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  /** Which new flags are sent to the portal: none, or this severity and above. */
  flagLevel: FlagAlertLevel;
}

/** What happened in the portal, written to the customer's notes. */
export type PortalEventType = 'suspended' | 'reactivated' | 'payment_failed' | 'plan_changed' | 'cancelled' | 'note';

export const PORTAL_EVENT_LABELS: Record<PortalEventType, string> = {
  suspended: 'Suspended',
  reactivated: 'Reactivated',
  payment_failed: 'Payment failed',
  plan_changed: 'Plan changed',
  cancelled: 'Cancelled',
  note: 'Note',
};

export interface PortalUsage {
  days: number;
  plays: number;
  hoursWatched: number;
  activeDays: number;
  /** Most streams playing at the same moment (on different devices). */
  peakStreams: number;
  peakStreamsAt: string | null;
  /** Devices that played something. */
  devicesUsed: number;
  /** Devices signed in to the account in Silo and used in the period. */
  devicesSignedIn: number;
  downloads: number;
  downloadGb: number;
  /** Share of plays over a VPN or data-centre network (0 to 1), when known. */
  vpnShare: number | null;
}

export interface PortalCustomer {
  id: string;
  username: string;
  email: string | null;
  /** From Silo: false when the account is turned off there. */
  enabled: boolean | null;
  createdAt: string | null;
  lastActiveAt: string | null;
  lastPlayedAt: string | null;
  watchingNow: number;
  /** The last 30 days. */
  usage: PortalUsage;
  /** The device they use most, e.g. "Fire TV Stick 4K Max (2021)". */
  mainDevice: string | null;
  playback: { status: 'fine' | 'struggling' | 'unknown'; issues: string[] };
  flags: { kind: string; group: string; severity: 'low' | 'medium' | 'high'; headline: string; since: string; reviewed: boolean }[];
  exceptions: { group: string; until: string | null; reason: string }[];
  /** A suspension request waiting for an admin, if any. */
  pendingSuspension: { action: 'suspend' | 'unsuspend'; requestedAt: string } | null;
  /** A link to the customer in Almanac, if Almanac knows its own address. */
  almanacUrl: string | null;
}
