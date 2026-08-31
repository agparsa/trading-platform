import { UserRole } from './enums/account';

/**
 * What someone is allowed to do, named as a capability rather than a route.
 *
 * A role is a shorthand for a set of these, not a permission in itself. The
 * distinction matters the first time a role has to be *narrowed*: with roles
 * checked directly, narrowing SUPPORT means finding every route that mentions
 * it; with permissions, it means removing one entry from one list.
 *
 * The names are `resource.verb` so a reader can tell at a glance what a route
 * touches without reading its handler.
 */
export const Permission = {
  // --- accounts ---
  ACCOUNTS_READ: 'accounts.read',
  ACCOUNTS_READ_ANY: 'accounts.read_any',
  ACCOUNTS_MANAGE: 'accounts.manage',
  /**
   * Post a correcting entry to an account's ledger.
   *
   * Separate from `accounts.manage`, and the separation is the point. Managing
   * an account means changing what it may *do* — freezing it, restricting it to
   * closing trades. This means changing what it is *worth*, and there is no
   * version of that which is a smaller power than the other one. Nobody gets it
   * by being able to suspend an account.
   */
  ACCOUNTS_ADJUST: 'accounts.adjust',

  // --- instruments ---
  /** See what the platform trades, and on what terms. */
  INSTRUMENTS_READ: 'instruments.read',
  /**
   * Enable or suspend an instrument, and change its trading terms.
   *
   * Sensitive well beyond an on/off switch: raising a margin rate changes the
   * margin required by every position already open in that instrument, and can
   * put an account into margin call without anyone touching it. Administrators
   * only, and every change is audited with both the old and the new value.
   */
  INSTRUMENTS_MANAGE: 'instruments.manage',

  // --- people ---
  /** Read any user's profile, accounts and sessions. */
  USERS_READ_ANY: 'users.read_any',
  /** Suspend, reinstate, and force a user's sessions to end. */
  USERS_MANAGE: 'users.manage',

  // --- trading ---
  ORDERS_READ: 'orders.read',
  ORDERS_CREATE: 'orders.create',
  ORDERS_CANCEL: 'orders.cancel',
  ORDERS_MODIFY: 'orders.modify',
  POSITIONS_READ: 'positions.read',
  POSITIONS_CLOSE: 'positions.close',
  POSITIONS_MODIFY: 'positions.modify',

  // --- oversight ---
  RISK_READ: 'risk.read',
  RISK_MANAGE: 'risk.manage',
  AUDIT_READ: 'audit.read',
  INTEGRITY_READ: 'integrity.read',
  INTEGRITY_MANAGE: 'integrity.manage',
  RECONCILIATION_READ: 'reconciliation.read',
  RECONCILIATION_RUN: 'reconciliation.run',

  // --- master accounts ---
  MASTER_READ: 'master.read',
  MASTER_MANAGE: 'master.manage',

  // --- system ---
  SYSTEM_KILL_SWITCH: 'system.kill_switch',
  SYSTEM_OPERATIONS: 'system.operations',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/**
 * What a trader may do — always to their **own** account.
 *
 * `ACCOUNTS_READ` means "read the accounts you own". Reading somebody else's is
 * a separate permission (`ACCOUNTS_READ_ANY`), because the two are different
 * powers and collapsing them is how a support tool quietly becomes a way to
 * browse the whole book. Ownership itself is still enforced by every query;
 * a permission is never a substitute for scoping a query to its owner.
 */
const TRADER: readonly Permission[] = [
  Permission.ACCOUNTS_READ,
  Permission.ORDERS_READ,
  Permission.ORDERS_CREATE,
  Permission.ORDERS_CANCEL,
  Permission.ORDERS_MODIFY,
  Permission.POSITIONS_READ,
  Permission.POSITIONS_CLOSE,
  Permission.POSITIONS_MODIFY,
];

/**
 * Roles are sets, not a ladder.
 *
 * Each list is written out in full rather than spreading a "lower" role into a
 * "higher" one. Ranking roles invites the assumption that a senior role can do
 * everything a junior one can — which stops being true the moment a role exists
 * to *restrict* someone, and by then the assumption is load-bearing.
 *
 * Note what ADMIN does **not** get: `orders.create`, `positions.close` or
 * `positions.modify` — at all, on any account, including their own.
 *
 * This is stronger than it first reads, and deliberately so. An administrator
 * can post to the ledger and change an instrument's margin rate; one who could
 * also trade could credit an account and trade the credit. Separating the two
 * is the whole point of having the capabilities apart, and a boundary that
 * bends for the administrator's own account is not a boundary.
 *
 * The practical consequence is worth stating plainly, because it surprises
 * everyone once: **an administrator cannot trade from their administrator
 * login.** Someone who needs to do both holds two logins, which is what
 * separation of duties means in practice. Where an administrator genuinely
 * needs to act on an account, a master-account link grants it per account and
 * leaves a record — see LINKABLE_CAPABILITIES.
 */
export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  [UserRole.USER]: TRADER,

  [UserRole.SUPPORT]: [
    Permission.ACCOUNTS_READ_ANY,
    Permission.USERS_READ_ANY,
    Permission.ORDERS_READ,
    Permission.POSITIONS_READ,
    Permission.MASTER_READ,
  ],

  [UserRole.OPERATOR]: [
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.USERS_READ_ANY,
    Permission.ORDERS_READ,
    Permission.ORDERS_CANCEL,
    Permission.POSITIONS_READ,
    Permission.POSITIONS_CLOSE,
    Permission.POSITIONS_MODIFY,
    Permission.RISK_READ,
    Permission.MASTER_READ,
    Permission.INTEGRITY_READ,
    Permission.INSTRUMENTS_READ,
    Permission.RECONCILIATION_READ,
    Permission.SYSTEM_OPERATIONS,
  ],

  [UserRole.RISK_MANAGER]: [
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.USERS_READ_ANY,
    Permission.USERS_MANAGE,
    Permission.ORDERS_READ,
    Permission.ORDERS_CANCEL,
    Permission.POSITIONS_READ,
    Permission.POSITIONS_CLOSE,
    Permission.RISK_READ,
    Permission.RISK_MANAGE,
    Permission.AUDIT_READ,
    Permission.MASTER_READ,
    Permission.INTEGRITY_READ,
    Permission.INTEGRITY_MANAGE,
    Permission.INSTRUMENTS_READ,
    Permission.RECONCILIATION_READ,
    Permission.RECONCILIATION_RUN,
    Permission.SYSTEM_OPERATIONS,
    Permission.SYSTEM_KILL_SWITCH,
  ],

  [UserRole.ADMIN]: [
    Permission.ACCOUNTS_READ,
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.ACCOUNTS_ADJUST,
    Permission.USERS_READ_ANY,
    Permission.USERS_MANAGE,
    Permission.ORDERS_READ,
    Permission.ORDERS_CANCEL,
    Permission.POSITIONS_READ,
    Permission.RISK_READ,
    Permission.RISK_MANAGE,
    Permission.AUDIT_READ,
    Permission.MASTER_READ,
    Permission.MASTER_MANAGE,
    Permission.INTEGRITY_READ,
    Permission.INTEGRITY_MANAGE,
    Permission.INSTRUMENTS_READ,
    Permission.INSTRUMENTS_MANAGE,
    Permission.RECONCILIATION_READ,
    Permission.RECONCILIATION_RUN,
    Permission.SYSTEM_OPERATIONS,
    Permission.SYSTEM_KILL_SWITCH,
  ],
};

export function permissionsFor(role: UserRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Does this role carry every permission listed? All of them, not any. */
export function roleHasPermissions(role: UserRole, required: readonly Permission[]): boolean {
  if (required.length === 0) return true;
  const held = new Set(permissionsFor(role));
  return required.every((permission) => held.has(permission));
}

/**
 * What a master-account link may ever grant.
 *
 * A delegation is authority over *one account*, so nothing that reaches beyond
 * that account can be delegated through one — no kill switch, no reconciliation
 * runs, no audit access, no power to create further delegations. Without a
 * ceiling, granting a link would be a way to mint any capability at all and
 * call it account management.
 *
 * `accounts.read_any` is deliberately absent for the same reason: a link is
 * permission to see *this* account, and a capability meaning "see every
 * account" cannot be scoped to one.
 */
export const LINKABLE_CAPABILITIES: readonly Permission[] = [
  Permission.ACCOUNTS_READ,
  Permission.ACCOUNTS_MANAGE,
  Permission.ORDERS_READ,
  Permission.ORDERS_CREATE,
  Permission.ORDERS_CANCEL,
  Permission.ORDERS_MODIFY,
  Permission.POSITIONS_READ,
  Permission.POSITIONS_CLOSE,
  Permission.POSITIONS_MODIFY,
  Permission.RISK_READ,
];

const LINKABLE = new Set<string>(LINKABLE_CAPABILITIES);

/** Is this a capability a link is allowed to carry at all? */
export function isLinkableCapability(value: string): value is Permission {
  return LINKABLE.has(value);
}
