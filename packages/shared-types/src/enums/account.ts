export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  /** Trading blocked, data still live (e.g. risk review). */
  RESTRICTED: 'RESTRICTED',
  /** Read-only: no new orders, existing positions may still be closed. */
  CLOSE_ONLY: 'CLOSE_ONLY',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

export const AccountType = {
  LIVE: 'LIVE',
  DEMO: 'DEMO',
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

export const UserRole = {
  USER: 'USER',
  SUPPORT: 'SUPPORT',
  OPERATOR: 'OPERATOR',
  ADMIN: 'ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

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
