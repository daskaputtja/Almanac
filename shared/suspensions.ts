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

export interface BillingPortalSettings {
  /** The portal's address, shown in full (it isn't secret). */
  url: string | null;
  /** True once a signing secret is saved; the secret itself is never shown again. */
  secretSet: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}
