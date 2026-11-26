/** Suspending accounts through the billing portal, with admin review of mods' requests. */

export type SuspensionAction = 'suspend' | 'unsuspend';
export type SuspensionStatus = 'pending' | 'rejected' | 'done' | 'failed';

export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 2000;

export interface SuspensionRequest {
  id: number;
  userId: string;
  username: string;
  email: string | null;
  action: SuspensionAction;
  reason: string;
  status: SuspensionStatus;
  requestedBy: string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** What the billing portal said (or why it couldn't be reached). */
  portalMessage: string | null;
}

export interface SuspensionsResponse {
  requests: SuspensionRequest[];
  /** Whether a billing portal is set up; without one nothing can be sent. */
  portalConfigured: boolean;
}

/** How suspensions reach the billing system: a custom portal (signed requests), or WHMCS (its own API). */
export type BillingKind = 'custom' | 'whmcs';

export interface WhmcsView {
  /** WHMCS's address. */
  url: string | null;
  /** The API credential's identifier (not secret, shown to tell credentials apart). */
  identifier: string | null;
  secretSet: boolean;
  accessKeySet: boolean;
  /** How a Silo account is matched to a WHMCS service. */
  match: 'username' | 'email' | 'username_or_email';
  /** WHMCS product IDs that are Silo plans; empty means any of the customer's services. */
  productIds: number[];
}

export interface BillingPortalSettings {
  kind: BillingKind;
  /** Suspensions can be sent: the chosen kind is fully set up. */
  ready: boolean;
  whmcs: WhmcsView;
  /** The portal's address, shown in full (it isn't secret). */
  url: string | null;
  /** True once a signing secret is saved; the secret itself is never shown again. */
  secretSet: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Checks that can reach "Serious", and so can file a suspension request automatically. */
export const AUTO_REQUEST_KINDS: import('./moderation.js').FlagKind[] = ['heavy_downloads', 'bulk_opening', 'nonstop', 'heavy_daily', 'concurrent_networks'];

/** Which serious flags file a suspension request by themselves (an admin still approves it). */
export interface AutoRequestSettings {
  kinds: import('./moderation.js').FlagKind[];
  updatedBy: string | null;
  updatedAt: string | null;
}
