export const AccountStatus = {
  /** Not yet usable: waiting on provisioning at a venue, or on a check. Nothing trades. */
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  /** Trading blocked, data still live (e.g. risk review). */
  RESTRICTED: 'RESTRICTED',
  /** Read-only: no new orders, existing positions may still be closed. */
  CLOSE_ONLY: 'CLOSE_ONLY',
  /**
   * A security lock: the holder's credentials are in doubt. The holder does
   * nothing, not even close — a stolen session must not be able to dump
   * positions — while the engine's own stops and the stop-out still run.
   */
  LOCKED: 'LOCKED',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

/**
 * What a status allows, in one table.
 *
 * `open` is a new order or position; `modify` is changing a stop or a
 * target; `close` is the holder (or a master account acting for them)
 * closing. The engine — a stop-loss firing, a liquidation — closes in every
 * status, because the alternative is a position nobody can stop losing on.
 *
 * Read by the API before it acts and by the clients to explain why a button
 * is off; the API's answer is the one that counts.
 */
export interface AccountStatusPolicy {
  readonly open: boolean;
  readonly modify: boolean;
  readonly close: boolean;
  /** One line a client can show. */
  readonly explanation: string;
}

export const ACCOUNT_STATUS_POLICY: Readonly<Record<AccountStatus, AccountStatusPolicy>> = {
  PENDING: {
    open: false,
    modify: false,
    close: false,
    explanation: 'This account is not active yet.',
  },
  ACTIVE: { open: true, modify: true, close: true, explanation: '' },
  RESTRICTED: {
    open: false,
    modify: true,
    close: true,
    explanation:
      'This account is restricted: existing positions can be managed and closed, none opened.',
  },
  CLOSE_ONLY: {
    open: false,
    modify: true,
    close: true,
    explanation:
      'This account is close-only: existing positions can be managed and closed, none opened.',
  },
  LOCKED: {
    open: false,
    modify: false,
    close: false,
    explanation: 'This account is locked for security. Contact support.',
  },
  SUSPENDED: {
    open: false,
    modify: false,
    close: true,
    explanation: 'This account is suspended: positions can be closed, nothing else.',
  },
  CLOSED: { open: false, modify: false, close: false, explanation: 'This account is closed.' },
};

export function accountStatusPolicy(status: string): AccountStatusPolicy {
  return (
    ACCOUNT_STATUS_POLICY[status as AccountStatus] ?? {
      open: false,
      modify: false,
      close: false,
      explanation: `This account is ${status.toLowerCase()}.`,
    }
  );
}

export const AccountType = {
  LIVE: 'LIVE',
  DEMO: 'DEMO',
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

/**
 * The roles a person may hold. A role is a key into a tenant's grant rows, not
 * an authorisation in itself — see `permissions.ts`.
 *
 * Three groups, one enum. A **broker** tenant seeds the broker and end-user
 * roles; the **platform** tenant seeds all three groups, because in a
 * single-operator deployment the platform is also the firm that trades. The
 * specification names some broker roles differently from the keys this
 * repository has carried since its first commit; `ROLE_ALIASES` in
 * `role-seed.ts` maps those names, and the keys stay, because a rename that
 * touches every row, token and test buys nothing a display name does not.
 */
export const UserRole = {
  // --- end user ---
  /** The specification's TRADING_USER. */
  USER: 'USER',

  // --- broker (a tenant's own staff) ---
  /** The specification's BROKER_SUPPORT. */
  SUPPORT: 'SUPPORT',
  OPERATOR: 'OPERATOR',
  /** The specification's BROKER_TRADING_MANAGER. */
  RISK_MANAGER: 'RISK_MANAGER',
  /**
   * Money out. Approves and pays withdrawals; deliberately cannot confirm a
   * deposit or adjust a wallet, because the two halves of "invent money, then
   * take it out" must never be one person's.
   */
  FINANCE: 'FINANCE',
  /** The specification's BROKER_ADMIN. */
  ADMIN: 'ADMIN',
  /** Everything an administrator may do, plus the firm's own settings and branding. */
  BROKER_OWNER: 'BROKER_OWNER',
  /** Reads everything in the firm; changes nothing. */
  BROKER_ANALYST: 'BROKER_ANALYST',
  /** Keys, tokens and — later — webhooks: the firm's integrations. */
  BROKER_DEVELOPER: 'BROKER_DEVELOPER',

  // --- platform (the operator of the deployment; seeded on the platform tenant only) ---
  PLATFORM_SUPER_ADMIN: 'PLATFORM_SUPER_ADMIN',
  PLATFORM_OPERATOR: 'PLATFORM_OPERATOR',
  PLATFORM_SUPPORT: 'PLATFORM_SUPPORT',
  PLATFORM_AUDITOR: 'PLATFORM_AUDITOR',
  PLATFORM_DEVELOPER: 'PLATFORM_DEVELOPER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Which group a role belongs to, which decides which tenants seed it. */
export const RoleGroup = {
  END_USER: 'END_USER',
  BROKER: 'BROKER',
  PLATFORM: 'PLATFORM',
} as const;
export type RoleGroup = (typeof RoleGroup)[keyof typeof RoleGroup];

export const ROLE_GROUP: Readonly<Record<UserRole, RoleGroup>> = {
  USER: RoleGroup.END_USER,
  SUPPORT: RoleGroup.BROKER,
  OPERATOR: RoleGroup.BROKER,
  RISK_MANAGER: RoleGroup.BROKER,
  FINANCE: RoleGroup.BROKER,
  ADMIN: RoleGroup.BROKER,
  BROKER_OWNER: RoleGroup.BROKER,
  BROKER_ANALYST: RoleGroup.BROKER,
  BROKER_DEVELOPER: RoleGroup.BROKER,
  PLATFORM_SUPER_ADMIN: RoleGroup.PLATFORM,
  PLATFORM_OPERATOR: RoleGroup.PLATFORM,
  PLATFORM_SUPPORT: RoleGroup.PLATFORM,
  PLATFORM_AUDITOR: RoleGroup.PLATFORM,
  PLATFORM_DEVELOPER: RoleGroup.PLATFORM,
};

/**
 * What kind of tenant this is.
 *
 * A broker is a tenant: every broker-owned row is tenant-scoped already. The
 * platform is the one tenant that operates the deployment — and, in a
 * single-operator deployment, also trades, which is why it seeds every role
 * group rather than only the platform one.
 */
export const TenantKind = {
  PLATFORM: 'PLATFORM',
  BROKER: 'BROKER',
} as const;
export type TenantKind = (typeof TenantKind)[keyof typeof TenantKind];

/**
 * Groups in order of reach. A role may be handed out by someone whose own group
 * is at least the role's: a broker administrator does not appoint platform
 * staff, however the grants happen to compare.
 */
const GROUP_RANK: Readonly<Record<RoleGroup, number>> = {
  [RoleGroup.END_USER]: 0,
  [RoleGroup.BROKER]: 1,
  [RoleGroup.PLATFORM]: 2,
};

export function groupOutranks(a: RoleGroup, b: RoleGroup): boolean {
  return GROUP_RANK[a] >= GROUP_RANK[b];
}

/** The roles a tenant of this kind seeds and may assign. */
export function rolesForTenantKind(kind: TenantKind): readonly UserRole[] {
  return (Object.values(UserRole) as UserRole[]).filter(
    (role) => kind === TenantKind.PLATFORM || ROLE_GROUP[role] !== RoleGroup.PLATFORM,
  );
}

/**
 * Where an account's orders execute.
 *
 * INTERNAL is the engine in this repository against its own ledger.
 * EXTERNAL_BROKER hands the order to a broker adapter and records what the
 * venue did — a path that exists as a mode before it exists as code, so that
 * nothing pretends a venue is connected when none is.
 */
export const ExecutionMode = {
  INTERNAL: 'INTERNAL',
  EXTERNAL_BROKER: 'EXTERNAL_BROKER',
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/** Immutable balance-ledger entry kinds. */
export const LedgerEntryType = {
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
  TRADE_PROFIT: 'TRADE_PROFIT',
  TRADE_LOSS: 'TRADE_LOSS',
  COMMISSION: 'COMMISSION',
  SWAP: 'SWAP',
  FEE: 'FEE',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];
