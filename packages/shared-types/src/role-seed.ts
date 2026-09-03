import {
  ROLE_GROUP,
  type RoleGroup,
  TenantKind,
  UserRole,
  rolesForTenantKind,
} from './enums/account';
import { type Permission, permissionsFor } from './permissions';

/**
 * The roles a tenant starts with, and what each is called.
 *
 * Here rather than in the API because four places need it and they cannot all
 * reach a Nest service: the API's `RolesService`, the database seed, the
 * integration harnesses, and the pentest script. Four transcriptions of the same
 * list is three that go stale, and the one that goes stale is the one that
 * decides what somebody may do.
 *
 * The grants themselves are not repeated — they come from `permissionsFor`, the
 * same constant the migration's seed was generated from.
 */
export interface SeedRole {
  readonly key: UserRole;
  readonly name: string;
  readonly description: string;
  readonly group: RoleGroup;
  readonly permissions: readonly Permission[];
}

/**
 * The specification's role names, where they differ from this repository's
 * keys. The keys stay: a rename that touches every row, token and test buys
 * nothing that a display name does not.
 */
export const ROLE_ALIASES: Readonly<Record<string, UserRole>> = {
  TRADING_USER: UserRole.USER,
  BROKER_SUPPORT: UserRole.SUPPORT,
  BROKER_TRADING_MANAGER: UserRole.RISK_MANAGER,
  BROKER_ADMIN: UserRole.ADMIN,
};

const NAMES: Readonly<Record<UserRole, { name: string; description: string }>> = {
  [UserRole.USER]: { name: 'Trader', description: 'Trades their own accounts.' },
  [UserRole.SUPPORT]: {
    name: 'Support',
    description: 'Reads across accounts to answer questions. Changes nothing.',
  },
  [UserRole.OPERATOR]: {
    name: 'Operator',
    description: 'Runs the desk: cancels, closes, manages accounts.',
  },
  [UserRole.RISK_MANAGER]: {
    name: 'Risk manager',
    description: 'Sets limits, acts on integrity signals, holds the kill switch.',
  },
  [UserRole.FINANCE]: {
    name: 'Finance',
    description:
      'Approves and pays withdrawals. Deliberately cannot confirm a deposit or adjust a wallet.',
  },
  [UserRole.ADMIN]: {
    name: 'Administrator',
    description: 'Everything administrative. Deliberately cannot open a position.',
  },
  [UserRole.BROKER_OWNER]: {
    name: 'Owner',
    description: "The administrator's powers plus the firm's own settings and branding.",
  },
  [UserRole.BROKER_ANALYST]: {
    name: 'Analyst',
    description: 'Reads everything in the firm. Changes nothing.',
  },
  [UserRole.BROKER_DEVELOPER]: {
    name: 'Developer',
    description: "The firm's integrations: keys, tokens, and what they need to read.",
  },
  [UserRole.PLATFORM_SUPER_ADMIN]: {
    name: 'Platform super administrator',
    description: 'Runs the platform: brokers, and everything an administrator may do here.',
  },
  [UserRole.PLATFORM_OPERATOR]: {
    name: 'Platform operator',
    description: 'Creates and manages brokers; intervenes on the desk; makes no money appear.',
  },
  [UserRole.PLATFORM_SUPPORT]: {
    name: 'Platform support',
    description: 'Reads across the platform to answer questions. Changes nothing.',
  },
  [UserRole.PLATFORM_AUDITOR]: {
    name: 'Platform auditor',
    description: 'Reads everything, including the audit and security feeds. Changes nothing.',
  },
  [UserRole.PLATFORM_DEVELOPER]: {
    name: 'Platform developer',
    description: "The platform's own integrations: keys and tokens.",
  },
};

/**
 * The roles a tenant of this kind seeds. A broker gets the broker and end-user
 * groups; the platform gets all three — in a single-operator deployment the
 * platform is also the firm that trades.
 */
export function seedRoles(kind: TenantKind = TenantKind.PLATFORM): readonly SeedRole[] {
  return rolesForTenantKind(kind).map((key) => ({
    key,
    name: NAMES[key].name,
    description: NAMES[key].description,
    group: ROLE_GROUP[key],
    permissions: permissionsFor(key),
  }));
}
