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
  mod: 'Sees activity, history, statistics, users and libraries, without IP addresses. Can’t manage accounts or notifications.',
};

export type Permission =
  /** See viewers' IP addresses (Activity, History, user pages) and search by them. */
  | 'viewIpAddresses'
  /** Add, change and remove Almanac accounts. */
  | 'manageAccounts'
  /** See and change notification settings (Discord and others). */
  | 'manageNotifications';

const GRANTS: Record<Permission, Role[]> = {
  viewIpAddresses: ['admin'],
  manageAccounts: ['admin'],
  manageNotifications: ['admin'],
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
