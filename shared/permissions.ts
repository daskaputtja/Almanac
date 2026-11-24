/**
 * Account roles and what each may do. The server enforces these; the
 * dashboard only uses them to hide things a role can't use.
 */

export type Role = 'admin' | 'mod';

export const ROLES: Role[] = ['admin', 'mod'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  mod: 'Mod',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Sees everything and manages accounts.',
  mod: 'Sees everything except IP addresses, handles flags, notes and tags, and can ask for an account to be suspended (an admin approves it). Can’t manage accounts or notifications.',
};

export type Permission =
  /** See viewers' IP addresses (Activity, History, user pages) and search by them. */
  | 'viewIpAddresses'
  /** Add, change and remove Almanac accounts. */
  | 'manageAccounts'
  /** See and change notification settings (Discord and others). */
  | 'manageNotifications'
  /** See account flags, review them, and read and write notes and tags on users. */
  | 'moderate'
  /** Edit or delete anyone's notes, not just your own. */
  | 'manageAllNotes'
  /** Change the thresholds the account checks use. */
  | 'configureFlags'
  /** Create and revoke links that show one user's recap without signing in. */
  | 'shareRecaps'
  /** Ask for an account to be suspended or unsuspended (an admin reviews it). */
  | 'requestSuspension'
  /** Approve or reject suspension requests, and suspend or unsuspend directly. */
  | 'reviewSuspension'
  /** Connect Almanac to the billing portal. */
  | 'configureBilling';

const GRANTS: Record<Permission, Role[]> = {
  viewIpAddresses: ['admin'],
  manageAccounts: ['admin'],
  manageNotifications: ['admin'],
  moderate: ['admin', 'mod'],
  manageAllNotes: ['admin'],
  configureFlags: ['admin'],
  shareRecaps: ['admin', 'mod'],
  requestSuspension: ['admin', 'mod'],
  reviewSuspension: ['admin'],
  configureBilling: ['admin'],
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return Boolean(role && GRANTS[permission].includes(role));
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(GRANTS) as Permission[]).filter((p) => can(role, p));
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}
