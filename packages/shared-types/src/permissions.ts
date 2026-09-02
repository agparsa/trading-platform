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

  // --- payments ---
  /** See your own payments. */
  PAYMENTS_READ: 'payments.read',
  /**
   * Start a deposit.
   *
   * Separate from `payments.read` for the reason stated on `accounts.read`:
   * seeing a thing and starting one are different powers, and a capability that
   * quietly means both cannot be granted to someone who should only look. It
   * also gives the pair below something to name — starting a payment and
   * confirming one, held together, is money out of nothing.
   */
  PAYMENTS_CREATE: 'payments.create',
  /** See anyone's payments. */
  PAYMENTS_READ_ANY: 'payments.read_any',
  /**
   * Confirm or reject a payment that a person has to settle — a bank transfer
   * an operator can see on a statement.
   *
   * Distinct from `wallet.adjust`, and the distinction is the point: this can
   * only settle a payment somebody started, for the amount they started it for,
   * and it leaves an intent and an event behind. `wallet.adjust` can credit any
   * wallet any amount. Both create money; only one of them has a counterparty.
   */
  PAYMENTS_CONFIRM: 'payments.confirm',

  // --- identity verification ---
  /** See your own verification status and what it is waiting on. */
  KYC_READ: 'kyc.read',
  /** Submit documents for review. */
  KYC_SUBMIT: 'kyc.submit',
  /** See anyone's verification *status* and the review queue — never the documents. */
  KYC_READ_ANY: 'kyc.read_any',
  /**
   * Open the documents themselves.
   *
   * Separate from `kyc.read_any` and the separation is the point. Knowing that
   * a person is verified is what a support agent needs to answer "why can't I
   * withdraw"; seeing their passport is not, and a capability that meant both
   * would put every identity document on the platform one support ticket away.
   * Every use of this one is audited with the reviewer's name against it.
   */
  KYC_DOCUMENTS_READ: 'kyc.documents.read',
  /** Decide: verify, reject, or revoke a verification already granted. */
  KYC_REVIEW: 'kyc.review',

  // --- withdrawals ---
  /** See your own withdrawals. */
  WITHDRAWALS_READ: 'withdrawals.read',
  /** Ask for money to be paid out of your wallet, and cancel the request before it is decided. */
  WITHDRAWALS_REQUEST: 'withdrawals.request',
  /** See anyone's withdrawals and the queue. */
  WITHDRAWALS_READ_ANY: 'withdrawals.read_any',
  /**
   * Approve or reject.
   *
   * The most consequential capability on the platform after the two that
   * create money, and it must never sit beside either of them: confirm a
   * deposit that never arrived, approve its withdrawal, and the firm pays out
   * money that never came in. See INCOMPATIBLE_PERMISSIONS.
   */
  WITHDRAWALS_REVIEW: 'withdrawals.review',
  /** Start a payout and record that it was paid, or that it failed. */
  WITHDRAWALS_PAY: 'withdrawals.pay',

  // --- users ---
  /**
   * Put a person into a role.
   *
   * Not part of `users.manage`, which suspends and reinstates. Changing what a
   * person may do is the one administrative act that changes every other
   * check, and it needs a name of its own so it can be granted — and audited
   * — on its own.
   */
  ROLES_ASSIGN: 'roles.assign',

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
  Permission.PAYMENTS_READ,
  Permission.PAYMENTS_CREATE,
  Permission.KYC_READ,
  Permission.KYC_SUBMIT,
  Permission.WITHDRAWALS_READ,
  Permission.WITHDRAWALS_REQUEST,
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
    Permission.PAYMENTS_READ_ANY,
    Permission.KYC_READ_ANY,
    Permission.WITHDRAWALS_READ_ANY,
    Permission.USERS_READ_ANY,
    Permission.ORDERS_READ,
    Permission.POSITIONS_READ,
    Permission.MASTER_READ,
  ],

  [UserRole.OPERATOR]: [
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.WALLET_READ_ANY,
    Permission.PAYMENTS_READ_ANY,
    Permission.KYC_READ_ANY,
    Permission.WITHDRAWALS_READ_ANY,
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
    Permission.PAYMENTS_READ_ANY,
    Permission.KYC_READ_ANY,
    Permission.KYC_DOCUMENTS_READ,
    Permission.KYC_REVIEW,
    Permission.WITHDRAWALS_READ_ANY,
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

  /**
   * Money out, and only money out.
   *
   * Holds `withdrawals.review` and `withdrawals.pay`, and reads everything it
   * needs to judge a request — wallets, payments, identity status. Holds
   * neither `payments.confirm` nor `wallet.adjust`: the two halves of "invent
   * money, then take it out" are never one person's, and that is what this
   * role exists to keep apart from `ADMIN`.
   */
  [UserRole.FINANCE]: [
    Permission.ACCOUNTS_READ_ANY,
    Permission.WALLET_READ_ANY,
    Permission.PAYMENTS_READ_ANY,
    Permission.KYC_READ_ANY,
    Permission.WITHDRAWALS_READ_ANY,
    Permission.WITHDRAWALS_REVIEW,
    Permission.WITHDRAWALS_PAY,
    Permission.USERS_READ_ANY,
    Permission.AUDIT_READ,
  ],

  [UserRole.ADMIN]: [
    Permission.ACCOUNTS_READ,
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.ACCOUNTS_ADJUST,
    Permission.WALLET_READ_ANY,
    Permission.WALLET_ADJUST,
    Permission.WALLET_MANAGE,
    Permission.PAYMENTS_READ_ANY,
    Permission.PAYMENTS_CONFIRM,
    Permission.KYC_READ_ANY,
    Permission.KYC_DOCUMENTS_READ,
    Permission.KYC_REVIEW,
    Permission.WITHDRAWALS_READ_ANY,
    Permission.USERS_READ_ANY,
    Permission.USERS_MANAGE,
    Permission.ROLES_ASSIGN,
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
  // Confirming a payment credits a wallet. It is narrower than `wallet.adjust` —
  // one payment, its own amount, with an intent behind it — and it is still a
  // way to make money appear, so it does not sit beside opening a position.
  [Permission.PAYMENTS_CONFIRM, Permission.ORDERS_CREATE],
  [Permission.PAYMENTS_CONFIRM, Permission.ORDERS_MODIFY],
  [Permission.PAYMENTS_CONFIRM, Permission.POSITIONS_MODIFY],
  /**
   * The shortest path to money out of nothing on this platform.
   *
   * Start a deposit for any amount, then confirm it by hand as an operator who
   * saw it on a statement. Both halves leave a record and both look ordinary on
   * their own; only holding them together turns them into a credit with no
   * counterparty. Every other pair here needs a market to launder through.
   */
  [Permission.PAYMENTS_CONFIRM, Permission.PAYMENTS_CREATE],
  /**
   * Verifying your own identity. The same shape as confirming your own
   * deposit, one step further from the money: a verification is what a
   * withdrawal gate asks for, so a role that can both submit and decide can
   * clear its own path out.
   */
  [Permission.KYC_REVIEW, Permission.KYC_SUBMIT],
  /**
   * Money out of nothing, complete. Confirm a deposit that never arrived, or
   * adjust a wallet upward, then approve its withdrawal: the firm pays out
   * money that never came in. These are the pairs the FINANCE role exists to
   * keep apart from ADMIN, and neither role may be edited into holding both.
   */
  [Permission.WITHDRAWALS_REVIEW, Permission.PAYMENTS_CONFIRM],
  [Permission.WITHDRAWALS_REVIEW, Permission.WALLET_ADJUST],
  [Permission.WITHDRAWALS_REVIEW, Permission.ACCOUNTS_ADJUST],
  [Permission.WITHDRAWALS_PAY, Permission.PAYMENTS_CONFIRM],
  [Permission.WITHDRAWALS_PAY, Permission.WALLET_ADJUST],
  [Permission.WITHDRAWALS_PAY, Permission.ACCOUNTS_ADJUST],
  /** Approving or paying your own withdrawal. */
  [Permission.WITHDRAWALS_REVIEW, Permission.WITHDRAWALS_REQUEST],
  [Permission.WITHDRAWALS_PAY, Permission.WITHDRAWALS_REQUEST],
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
