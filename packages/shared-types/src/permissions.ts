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

  // --- programmatic access ---
  /**
   * Mint, list and revoke **your own** API keys.
   *
   * A key acts as the person who minted it, with a subset of their
   * capabilities fixed at minting — see KEYABLE_PERMISSIONS for what may be in
   * that subset and why some things may not.
   */
  API_KEYS_MANAGE: 'api_keys.manage',
  /**
   * See every key in the tenant: who holds one, what it carries, when it was
   * last used and from where. Never the secret — nobody has it, including the
   * platform.
   */
  API_KEYS_READ_ANY: 'api_keys.read_any',
  /** Revoke anyone's key. The response to a leak, and it needs no more than that. */
  API_KEYS_REVOKE_ANY: 'api_keys.revoke_any',
  /**
   * Mint, list and revoke service tokens: machine identities that belong to
   * the firm rather than to a person, for an integration that reads the
   * platform. See SERVICE_GRANTABLE_PERMISSIONS for what one may carry.
   */
  SERVICE_TOKENS_MANAGE: 'service_tokens.manage',

  // --- tenants (the platform's view of its brokers) ---
  /** See which brokers exist and their status. Platform roles only. */
  TENANTS_READ: 'tenants.read',
  /**
   * Create a broker, change its status or hostname, hand its first owner an
   * invitation. Held by the platform's operators and nobody in a broker: a
   * broker that could create brokers would be the platform.
   */
  TENANTS_MANAGE: 'tenants.manage',
  /** A firm's own settings and branding. The owner's, and the platform's. */
  TENANT_SETTINGS_MANAGE: 'tenant.settings.manage',

  // --- broker connections ---
  /**
   * See a firm's venue connections: which connector, whether it is up, how
   * late it is. Never a credential — those never leave the server in any
   * form, for any capability.
   */
  BROKER_CONNECTIONS_READ: 'broker_connections.read',
  /**
   * Create a connection, change its settings, enable or disable it, and set
   * or rotate the credentials it authenticates with. Person-only: a leaked
   * key that could point a firm's execution at a venue of its holder's
   * choosing is the worst thing on this list.
   */
  BROKER_CONNECTIONS_MANAGE: 'broker_connections.manage',

  // --- security ---
  /**
   * The security event feed: sign-ins, lockouts, second factors, sessions
   * ended, credentials minted and revoked, roles assigned. Separate from
   * `audit.read` because it is read by support to answer "why can't I sign
   * in" and by risk to notice a pattern, neither of whom needs the whole
   * audit trail to do it.
   */
  SECURITY_READ: 'security.read',

  // --- system ---
  SYSTEM_KILL_SWITCH: 'system.kill_switch',
  SYSTEM_OPERATIONS: 'system.operations',
  /**
   * Open a break-glass grant and see one trader's own view of the platform (§9).
   *
   * Its own permission, held by nobody by default — not implied by being an
   * administrator, because "can manage the firm" and "can look through a
   * customer's eyes" are different powers and a firm should have to decide the
   * second one deliberately. Granting it to a role is that decision.
   */
  SECURITY_BREAK_GLASS: 'security.break_glass',
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
  Permission.API_KEYS_MANAGE,
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
/**
 * The administrator's set, named because two roles are built on it: the
 * firm's owner (this plus the firm's own settings) and the platform's super
 * administrator (this plus the platform's brokers).
 */
const ADMIN_PERMISSIONS: readonly Permission[] = [
  /**
   * Break-glass lives with the administrator, and deliberately **not** with
   * SUPPORT.
   *
   * Support is who needs it day to day, which is exactly the argument for not
   * giving it to them by default: "anyone on the support rota can look through
   * any customer's eyes" is a different security posture from "a named senior
   * person can, with a reason, for an hour". A firm that wants the first should
   * decide it on purpose.
   *
   * It sits on the *tenant's* administrator rather than the platform's because
   * a grant cannot cross tenants — a platform-only permission would be useless
   * for the case it exists for, which is a broker supporting its own trader.
   */
  Permission.SECURITY_BREAK_GLASS,
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
  Permission.BROKER_CONNECTIONS_READ,
  Permission.BROKER_CONNECTIONS_MANAGE,
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
  Permission.API_KEYS_READ_ANY,
  Permission.API_KEYS_REVOKE_ANY,
  Permission.SERVICE_TOKENS_MANAGE,
  Permission.SECURITY_READ,
];

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
    Permission.API_KEYS_READ_ANY,
    Permission.SECURITY_READ,
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
    Permission.BROKER_CONNECTIONS_READ,
    Permission.SYSTEM_OPERATIONS,
    Permission.API_KEYS_READ_ANY,
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
    Permission.BROKER_CONNECTIONS_READ,
    Permission.RECONCILIATION_MANAGE,
    Permission.RECONCILIATION_RUN,
    Permission.ROLES_READ,
    Permission.SYSTEM_OPERATIONS,
    Permission.SYSTEM_KILL_SWITCH,
    Permission.API_KEYS_READ_ANY,
    Permission.API_KEYS_REVOKE_ANY,
    Permission.SECURITY_READ,
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

  [UserRole.ADMIN]: ADMIN_PERMISSIONS,

  /**
   * The firm's owner: the administrator's set, plus the firm's own settings
   * and branding. Nothing else — the owner is bound by the same separations as
   * the administrator, and cannot trade or approve a withdrawal either.
   */
  [UserRole.BROKER_OWNER]: [...ADMIN_PERMISSIONS, Permission.TENANT_SETTINGS_MANAGE],

  /** Reads everything in the firm and changes nothing. */
  [UserRole.BROKER_ANALYST]: [
    Permission.ACCOUNTS_READ_ANY,
    Permission.USERS_READ_ANY,
    Permission.ORDERS_READ,
    Permission.POSITIONS_READ,
    Permission.WALLET_READ_ANY,
    Permission.PAYMENTS_READ_ANY,
    Permission.KYC_READ_ANY,
    Permission.WITHDRAWALS_READ_ANY,
    Permission.RISK_READ,
    Permission.AUDIT_READ,
    Permission.MASTER_READ,
    Permission.INTEGRITY_READ,
    Permission.INSTRUMENTS_READ,
    Permission.RECONCILIATION_READ,
    Permission.ROLES_READ,
    Permission.API_KEYS_READ_ANY,
    Permission.SECURITY_READ,
    Permission.BROKER_CONNECTIONS_READ,
  ],

  /** The firm's integrations: keys, tokens, and what they need to read to be built. */
  [UserRole.BROKER_DEVELOPER]: [
    Permission.INSTRUMENTS_READ,
    Permission.ACCOUNTS_READ_ANY,
    Permission.ROLES_READ,
    Permission.API_KEYS_MANAGE,
    Permission.API_KEYS_READ_ANY,
    Permission.SERVICE_TOKENS_MANAGE,
    Permission.BROKER_CONNECTIONS_READ,
  ],

  /**
   * The platform's roles. Seeded on the platform tenant only, so a broker's
   * administrator can neither hold nor assign one — the row does not exist
   * where they are.
   */
  [UserRole.PLATFORM_SUPER_ADMIN]: [
    ...ADMIN_PERMISSIONS,
    Permission.TENANTS_READ,
    Permission.TENANTS_MANAGE,
    Permission.TENANT_SETTINGS_MANAGE,
  ],

  [UserRole.PLATFORM_OPERATOR]: [
    Permission.TENANTS_READ,
    Permission.TENANTS_MANAGE,
    Permission.ACCOUNTS_READ_ANY,
    Permission.ACCOUNTS_MANAGE,
    Permission.USERS_READ_ANY,
    Permission.USERS_MANAGE,
    Permission.ORDERS_READ,
    Permission.ORDERS_CANCEL,
    Permission.POSITIONS_READ,
    Permission.POSITIONS_CLOSE,
    Permission.RISK_READ,
    Permission.MASTER_READ,
    Permission.INTEGRITY_READ,
    Permission.INSTRUMENTS_READ,
    Permission.RECONCILIATION_READ,
    Permission.BROKER_CONNECTIONS_READ,
    Permission.RECONCILIATION_RUN,
    Permission.ROLES_READ,
    Permission.API_KEYS_READ_ANY,
    Permission.API_KEYS_REVOKE_ANY,
    Permission.SECURITY_READ,
    Permission.SYSTEM_OPERATIONS,
  ],

  [UserRole.PLATFORM_SUPPORT]: [
    Permission.TENANTS_READ,
    Permission.ACCOUNTS_READ_ANY,
    Permission.USERS_READ_ANY,
    Permission.ORDERS_READ,
    Permission.POSITIONS_READ,
    Permission.WALLET_READ_ANY,
    Permission.PAYMENTS_READ_ANY,
    Permission.KYC_READ_ANY,
    Permission.WITHDRAWALS_READ_ANY,
    Permission.MASTER_READ,
    Permission.API_KEYS_READ_ANY,
    Permission.SECURITY_READ,
    Permission.BROKER_CONNECTIONS_READ,
  ],

  /** Reads everything, including the audit and security feeds, and changes nothing. */
  [UserRole.PLATFORM_AUDITOR]: [
    Permission.TENANTS_READ,
    Permission.ACCOUNTS_READ_ANY,
    Permission.USERS_READ_ANY,
    Permission.ORDERS_READ,
    Permission.POSITIONS_READ,
    Permission.WALLET_READ_ANY,
    Permission.PAYMENTS_READ_ANY,
    Permission.KYC_READ_ANY,
    Permission.WITHDRAWALS_READ_ANY,
    Permission.RISK_READ,
    Permission.AUDIT_READ,
    Permission.MASTER_READ,
    Permission.INTEGRITY_READ,
    Permission.INSTRUMENTS_READ,
    Permission.RECONCILIATION_READ,
    Permission.BROKER_CONNECTIONS_READ,
    Permission.ROLES_READ,
    Permission.API_KEYS_READ_ANY,
    Permission.SECURITY_READ,
  ],

  [UserRole.PLATFORM_DEVELOPER]: [
    Permission.TENANTS_READ,
    Permission.INSTRUMENTS_READ,
    Permission.ROLES_READ,
    Permission.API_KEYS_MANAGE,
    Permission.API_KEYS_READ_ANY,
    Permission.SERVICE_TOKENS_MANAGE,
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

/**
 * The four shapes a delegation usually takes.
 *
 * ## Why these are presets and not roles
 *
 * A role is a live reference: change what `RISK_MANAGER` may do and every
 * risk manager's powers move with it, which is exactly what a role is for.
 * A delegation must not work that way. "Hossein may trade this account" is a
 * decision someone made about one person and one account on one day, and
 * widening `MASTER_TRADER` next quarter must not silently widen every
 * delegation ever made under that name — a desk manager would find their
 * operators able to do things nobody granted them.
 *
 * So these expand **at grant time** into the explicit capability list stored
 * on the link, and the link is what is enforced. The name is kept beside it
 * so a screen can say "Trader" instead of listing eight strings, and so an
 * audit row records what was asked for as well as what it became — but if the
 * two ever disagree, the stored capabilities win, because they are what the
 * granter actually approved.
 *
 * The ladder is nested: each preset contains the one below it, so "more than a
 * viewer, less than a manager" has an unambiguous answer.
 *
 * **`MASTER_OWNER` and `MASTER_MANAGER` presently expand to the same ten
 * capabilities**, because the linkable ceiling currently *is* the manager set.
 * Both names are kept, and they are not an alias for one another: `OWNER` is
 * defined as the ceiling and `MANAGER` as an explicit list, so the next
 * capability added to the ceiling reaches an owner and does not reach a
 * manager. Naming the coincidence here rather than deleting a preset means
 * the day it stops being true is a day nothing has to change.
 */
export const MasterRole = {
  /** Watches. Cannot move a position or an order. */
  MASTER_VIEWER: 'MASTER_VIEWER',
  /** Trades the account: opens, closes, modifies. Cannot change the account. */
  MASTER_TRADER: 'MASTER_TRADER',
  /** Trades, and may change the account's own settings. */
  MASTER_MANAGER: 'MASTER_MANAGER',
  /** Everything a delegation is permitted to carry. */
  MASTER_OWNER: 'MASTER_OWNER',
} as const;
export type MasterRole = (typeof MasterRole)[keyof typeof MasterRole];

const MASTER_VIEWER_CAPS: readonly Permission[] = [
  Permission.ACCOUNTS_READ,
  Permission.ORDERS_READ,
  Permission.POSITIONS_READ,
  Permission.RISK_READ,
];
const MASTER_TRADER_CAPS: readonly Permission[] = [
  ...MASTER_VIEWER_CAPS,
  Permission.ORDERS_CREATE,
  Permission.ORDERS_CANCEL,
  Permission.ORDERS_MODIFY,
  Permission.POSITIONS_CLOSE,
  Permission.POSITIONS_MODIFY,
];
const MASTER_MANAGER_CAPS: readonly Permission[] = [...MASTER_TRADER_CAPS, Permission.ACCOUNTS_MANAGE];

/**
 * What each preset expands to.
 *
 * `MASTER_OWNER` is `LINKABLE_CAPABILITIES` itself rather than a copy of it,
 * so a capability added to the ceiling reaches the top preset without a second
 * edit — and a capability the ceiling refuses cannot appear here at all. The
 * test below the definition asserts every preset stays inside the ceiling.
 */
export const MASTER_ROLE_CAPABILITIES: Readonly<Record<MasterRole, readonly Permission[]>> = {
  [MasterRole.MASTER_VIEWER]: MASTER_VIEWER_CAPS,
  [MasterRole.MASTER_TRADER]: MASTER_TRADER_CAPS,
  [MasterRole.MASTER_MANAGER]: MASTER_MANAGER_CAPS,
  [MasterRole.MASTER_OWNER]: LINKABLE_CAPABILITIES,
};

const MASTER_ROLES = new Set<string>(Object.keys(MASTER_ROLE_CAPABILITIES));

export function isMasterRole(value: string): value is MasterRole {
  return MASTER_ROLES.has(value);
}

/**
 * The preset a capability list amounts to, or `null` when it is its own thing.
 *
 * Used only for display: a link granted as a preset keeps the name it was
 * granted under, and this answers for links written before presets existed,
 * or assembled capability by capability. A list that is not exactly a preset
 * is shown as what it is rather than rounded to the nearest name.
 *
 * While the ceiling equals the manager set, an owner's list and a manager's
 * are indistinguishable and this answers `MASTER_OWNER` — the widest name for
 * the widest grant, which is the reading that cannot understate what someone
 * was given.
 */
export function masterRoleOf(capabilities: readonly string[]): MasterRole | null {
  const held = new Set(capabilities);
  for (const role of [
    MasterRole.MASTER_OWNER,
    MasterRole.MASTER_MANAGER,
    MasterRole.MASTER_TRADER,
    MasterRole.MASTER_VIEWER,
  ]) {
    const wanted = MASTER_ROLE_CAPABILITIES[role];
    if (wanted.length === held.size && wanted.every((one) => held.has(one))) return role;
  }
  return null;
}

/**
 * What an API key may **not** carry, whatever its holder holds.
 *
 * A key acts as the person who minted it, so the question is not "may this
 * person do it" — they may — but "may a long-lived secret in a config file do
 * it without them". For most capabilities the answer is yes: that is what a
 * key is for. For these it is no, each for one of three reasons:
 *
 *   - **money appears or leaves** — adjusting a ledger, confirming a deposit,
 *     asking for or approving a withdrawal. A leaked key must not be able to
 *     drain a wallet to a new destination, and a person confirming a bank
 *     transfer is a person reading a statement;
 *   - **it changes who may do what** — roles, users, invitations, and keys
 *     themselves. A key that can mint keys is a key that never expires;
 *   - **it is an act the platform records as a person's** — opening an
 *     identity document, halting trading, changing an instrument's terms.
 *
 * A list of exclusions rather than inclusions, so a capability added later is
 * keyable unless somebody decides otherwise — the ordinary case — and the
 * decision, when made, is one entry here with the reason above it.
 */
export const PERSON_ONLY_PERMISSIONS: readonly Permission[] = [
  Permission.ACCOUNTS_ADJUST,
  Permission.ACCOUNTS_MANAGE,
  Permission.WALLET_ADJUST,
  Permission.WALLET_MANAGE,
  Permission.PAYMENTS_CREATE,
  Permission.PAYMENTS_CONFIRM,
  Permission.WITHDRAWALS_REQUEST,
  Permission.WITHDRAWALS_REVIEW,
  Permission.WITHDRAWALS_PAY,
  Permission.KYC_SUBMIT,
  Permission.KYC_DOCUMENTS_READ,
  Permission.KYC_REVIEW,
  Permission.USERS_MANAGE,
  Permission.ROLES_ASSIGN,
  Permission.ROLES_MANAGE,
  Permission.INVITES_MANAGE,
  Permission.API_KEYS_MANAGE,
  Permission.API_KEYS_REVOKE_ANY,
  Permission.SERVICE_TOKENS_MANAGE,
  Permission.INSTRUMENTS_MANAGE,
  Permission.MASTER_MANAGE,
  Permission.INTEGRITY_MANAGE,
  Permission.RECONCILIATION_MANAGE,
  Permission.RISK_MANAGE,
  Permission.SYSTEM_KILL_SWITCH,
  Permission.SYSTEM_OPERATIONS,
  Permission.TENANTS_MANAGE,
  Permission.TENANT_SETTINGS_MANAGE,
  /**
   * A venue connection decides where a firm's orders go and holds the
   * credentials that send them. A long-lived secret in a config file must not
   * be able to repoint a firm's execution at a venue of its holder's choosing.
   */
  Permission.BROKER_CONNECTIONS_MANAGE,
  /**
   * Break-glass is a person looking through a customer's eyes, with a reason
   * somebody can be asked about afterwards. A key in a config file has no eyes
   * and cannot be asked anything, and a long-lived secret that can read any
   * trader's private view is the single worst thing to leave in a `.env`.
   */
  Permission.SECURITY_BREAK_GLASS,
];

/** What an API key may carry: everything a person may hold that is not person-only. */
export const KEYABLE_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) => !PERSON_ONLY_PERMISSIONS.includes(permission),
);

export function isKeyable(value: string): value is Permission {
  return (KEYABLE_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * What a service token may carry: **reads across the tenant, and nothing else.**
 *
 * A service token belongs to the firm, not to a person, and that is exactly
 * the problem with letting it write. Every write on this platform is audited
 * against the person who made it, and the audit log has no way to say "an
 * integration did this" — an actor column that is a user id or nothing. Until
 * it has one, a machine may look and may not touch; and the routes a machine
 * may look at are the ones that read across accounts rather than "mine",
 * because a token has no "mine".
 *
 * An inclusion list, unlike the one above, because the safe default for a
 * machine identity is the opposite of the safe default for a person's key:
 * nothing, until somebody decides otherwise.
 */
export const SERVICE_GRANTABLE_PERMISSIONS: readonly Permission[] = [
  Permission.ACCOUNTS_READ_ANY,
  Permission.USERS_READ_ANY,
  Permission.WALLET_READ_ANY,
  Permission.PAYMENTS_READ_ANY,
  Permission.KYC_READ_ANY,
  Permission.WITHDRAWALS_READ_ANY,
  Permission.RISK_READ,
  Permission.AUDIT_READ,
  Permission.INSTRUMENTS_READ,
  Permission.RECONCILIATION_READ,
  Permission.INTEGRITY_READ,
  Permission.MASTER_READ,
  Permission.ROLES_READ,
  Permission.API_KEYS_READ_ANY,
];

export function isServiceGrantable(value: string): value is Permission {
  return (SERVICE_GRANTABLE_PERMISSIONS as readonly string[]).includes(value);
}
