import { UserRole } from './enums/account';
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
  readonly permissions: readonly Permission[];
}

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
};

export function seedRoles(): readonly SeedRole[] {
  return Object.values(UserRole).map((key) => ({
    key,
    name: NAMES[key].name,
    description: NAMES[key].description,
    permissions: permissionsFor(key),
  }));
}
