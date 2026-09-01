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

  // --- registration ---
  /**
   * Mint, list and revoke invitations, when the platform runs in invite mode.
   *
   * Separate from `users.manage` because inviting someone in and acting on an
   * existing user are different powers, and a support role that can suspend an
   * account should not thereby be able to create the next hundred.
   */
  INVITES_MANAGE: 'invites.manage',

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
  /**
   * Record a decision about a finding: acknowledged, investigating, resolved,
   * false positive.
   *
   * Separate from `RECONCILIATION_READ` because closing a finding is a write,
   * and a permission whose name says read must not authorise one. The two were
   * the same permission until the API audit noticed that an operator holding
   * only read could mark a discrepancy resolved.
   *
   * Separate from `RECONCILIATION_RUN` too: starting a comparison and deciding
   * what its output means are different acts, and the second is the one that
   * makes a discrepancy stop being visible.
   */
  RECONCILIATION_MANAGE: 'reconciliation.manage',
  RECONCILIATION_RUN: 'reconciliation.run',

  // --- master accounts ---
  MASTER_READ: 'master.read',
  MASTER_MANAGE: 'master.manage',

  // --- wallets ---
  /** Read **your own** wallet and its movements. */
  WALLET_READ: 'wallet.read',
  /** Read anyone's wallet. Separate for the same reason `accounts.read_any` is. */
  WALLET_READ_ANY: 'wallet.read_any',
  /** Move your own money between your wallet and your trading accounts. */
  WALLET_TRANSFER: 'wallet.transfer',
  /**
   * Credit or debit a wallet directly — recording that money arrived by bank
   * transfer, or correcting a mistake.
   *
   * The same power as `accounts.adjust` pointed at a different pot: it changes
   * what somebody's money *is*, not what it may do. Nobody gets it by being able
   * to freeze a wallet, and no role may hold it alongside a capability that
   * opens a position. See INCOMPATIBLE_PERMISSIONS.
   */
  WALLET_ADJUST: 'wallet.adjust',
  /** Freeze and unfreeze a wallet. Holding money is not taking it. */
  WALLET_MANAGE: 'wallet.manage',

  // --- roles ---
  /** See which roles exist and what each one carries. */
  ROLES_READ: 'roles.read',
  /**
   * Change what a role carries.
   *
   * The meta-permission, and the most dangerous one on this list, because a
   * holder could otherwise grant themselves everything else. Two rules bound it
   * and both are enforced server-side: nobody may grant a capability they do not
   * themselves hold (`escalationsIn`), and no role may hold a combination this
   * file calls incompatible (`conflictsIn`).
   */
  ROLES_MANAGE: 'roles.manage',

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
  Permission.WALLET_READ,
  Permission.WALLET_TRANSFER,
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
    Permission.WALLET_READ_ANY,
    Permission.USERS_READ_ANY,
    Permission.ORDERS_READ,
    Permission.POSITIONS_READ,
    Permission.MASTER_READ,
  ],

  [UserRole.OPERATOR]: [
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.WALLET_READ_ANY,
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
    Permission.WALLET_READ_ANY,
    Permission.WALLET_MANAGE,
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
    Permission.RECONCILIATION_MANAGE,
    Permission.RECONCILIATION_RUN,
    Permission.ROLES_READ,
    Permission.SYSTEM_OPERATIONS,
    Permission.SYSTEM_KILL_SWITCH,
  ],

  [UserRole.ADMIN]: [
    Permission.ACCOUNTS_READ,
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.ACCOUNTS_ADJUST,
    Permission.WALLET_READ_ANY,
    Permission.WALLET_ADJUST,
    Permission.WALLET_MANAGE,
    Permission.USERS_READ_ANY,
    Permission.USERS_MANAGE,
    Permission.INVITES_MANAGE,
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
    Permission.RECONCILIATION_MANAGE,
    Permission.RECONCILIATION_RUN,
    /**
     * Only ADMIN edits roles. `escalationsIn` already bounds what any editor can
     * grant, so this is not the safety mechanism — it is the smaller statement
     * that changing what a role means is an administrative act, not an
     * operational one, and a risk manager halting trading at 3am should not be
     * one keystroke from rewriting their own capabilities.
     */
    Permission.ROLES_READ,
    Permission.ROLES_MANAGE,
    Permission.SYSTEM_OPERATIONS,
    Permission.SYSTEM_KILL_SWITCH,
  ],
};

/**
 * Combinations no single role may hold, whatever an administrator asks for.
 *
 * ## Why this is a refusal rather than a warning
 *
 * The plan for this phase left the choice open: forbid the combination outright,
 * or allow it with a loud warning and an audit record. Forbidding it, for one
 * reason — a warning that can be clicked past is a warning that will be clicked
 * past, and the audit record it leaves describes a platform that is already
 * misconfigured. The whole argument for `ADMIN` not holding `orders.create` is
 * that crediting an account and trading the credit must not be one person's
 * capability. A rule that yields on a Tuesday afternoon is not that argument; it
 * is a note about it.
 *
 * The escape is the same one separation of duties always has: two roles, two
 * logins, or a master-account link that names the account and leaves a record.
 *
 * ## Why these pairs
 *
 * `accounts.adjust` writes to a ledger. Every capability paired with it here
 * turns a ledger entry into a market position — invent the money, then trade it,
 * and the second act is what makes the first hard to see. `positions.modify` is
 * on the list because moving a stop moves money on close just as surely as
 * opening the position did.
 *
 * `orders.cancel` and `positions.close` are deliberately **not** here. Stopping
 * something is not starting it, which is the same distinction that lets `ADMIN`
 * keep them.
 */
export const INCOMPATIBLE_PERMISSIONS: readonly (readonly [Permission, Permission])[] = [
  [Permission.ACCOUNTS_ADJUST, Permission.ORDERS_CREATE],
  [Permission.ACCOUNTS_ADJUST, Permission.ORDERS_MODIFY],
  [Permission.ACCOUNTS_ADJUST, Permission.POSITIONS_MODIFY],
  // `wallet.adjust` is the same power aimed at a different pot. Money invented
  // in a wallet reaches a position through one transfer, which the holder is
  // entitled to make on their own wallet.
  [Permission.WALLET_ADJUST, Permission.ORDERS_CREATE],
  [Permission.WALLET_ADJUST, Permission.ORDERS_MODIFY],
  [Permission.WALLET_ADJUST, Permission.POSITIONS_MODIFY],
];

/** Every incompatible pair present in this set. Empty means the set is allowed. */
export function conflictsIn(
  permissions: Iterable<Permission>,
): readonly (readonly [Permission, Permission])[] {
  const held = new Set(permissions);
  return INCOMPATIBLE_PERMISSIONS.filter(([a, b]) => held.has(a) && held.has(b));
}

/**
 * What `granted` contains that `heldByEditor` does not.
 *
 * Editing a role is how someone with `roles.manage` would escalate, and the
 * bound is the oldest one there is: you cannot give away what you do not have.
 * Note that it applies to the *result*, not to the diff — an editor removing a
 * capability they lack is fine, and this returns nothing for it.
 */
export function escalationsIn(
  granted: Iterable<Permission>,
  heldByEditor: Iterable<Permission>,
): readonly Permission[] {
  const held = new Set(heldByEditor);
  return [...new Set(granted)].filter((permission) => !held.has(permission));
}

const KNOWN = new Set<string>(ALL_PERMISSIONS);

/** Is this string one of the capabilities this build knows about? */
export function isPermission(value: string): value is Permission {
  return KNOWN.has(value);
}

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
