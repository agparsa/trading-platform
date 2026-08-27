import { describe, expect, it } from 'vitest';
import { UserRole } from './enums/account';
import {
  ALL_PERMISSIONS,
  Permission,
  permissionsFor,
  ROLE_PERMISSIONS,
  roleHasPermissions,
} from './permissions';

/**
 * The permission catalogue is a security control, so what is asserted here is
 * mostly what each role *cannot* do. A test that only checks the happy path
 * would pass just as happily if every role were granted everything.
 */
describe('roleHasPermissions', () => {
  it('requires every listed permission, not any of them', () => {
    expect(
      roleHasPermissions(UserRole.USER, [Permission.ORDERS_CREATE, Permission.POSITIONS_CLOSE]),
    ).toBe(true);
    expect(
      roleHasPermissions(UserRole.USER, [Permission.ORDERS_CREATE, Permission.SYSTEM_KILL_SWITCH]),
    ).toBe(false);
  });

  it('grants an empty requirement', () => {
    expect(roleHasPermissions(UserRole.USER, [])).toBe(true);
  });
});

describe('what a trader may do', () => {
  it('can trade their own account', () => {
    for (const permission of [
      Permission.ACCOUNTS_READ,
      Permission.ORDERS_CREATE,
      Permission.ORDERS_CANCEL,
      Permission.POSITIONS_CLOSE,
      Permission.POSITIONS_MODIFY,
    ]) {
      expect(roleHasPermissions(UserRole.USER, [permission])).toBe(true);
    }
  });

  /**
   * The distinction that matters most. Reading your own accounts and reading
   * anyone's are different powers; collapsing them is how a support tool
   * quietly becomes a way to browse the whole book.
   */
  it('cannot read another account, run operations, or touch the kill switch', () => {
    for (const permission of [
      Permission.ACCOUNTS_READ_ANY,
      Permission.ACCOUNTS_MANAGE,
      Permission.RISK_MANAGE,
      Permission.AUDIT_READ,
      Permission.MASTER_READ,
      Permission.INTEGRITY_READ,
      Permission.SYSTEM_OPERATIONS,
      Permission.SYSTEM_KILL_SWITCH,
    ]) {
      expect(roleHasPermissions(UserRole.USER, [permission])).toBe(false);
    }
  });
});

describe('separation between oversight roles', () => {
  it('lets support look but not touch', () => {
    expect(roleHasPermissions(UserRole.SUPPORT, [Permission.ACCOUNTS_READ_ANY])).toBe(true);
    expect(roleHasPermissions(UserRole.SUPPORT, [Permission.POSITIONS_CLOSE])).toBe(false);
    expect(roleHasPermissions(UserRole.SUPPORT, [Permission.ACCOUNTS_MANAGE])).toBe(false);
  });

  it('lets an operator intervene but not change risk policy or stop the platform', () => {
    expect(roleHasPermissions(UserRole.OPERATOR, [Permission.POSITIONS_CLOSE])).toBe(true);
    expect(roleHasPermissions(UserRole.OPERATOR, [Permission.ACCOUNTS_MANAGE])).toBe(true);
    expect(roleHasPermissions(UserRole.OPERATOR, [Permission.RISK_MANAGE])).toBe(false);
    expect(roleHasPermissions(UserRole.OPERATOR, [Permission.SYSTEM_KILL_SWITCH])).toBe(false);
    expect(roleHasPermissions(UserRole.OPERATOR, [Permission.AUDIT_READ])).toBe(false);
  });

  it('gives the risk manager the kill switch and the audit trail', () => {
    expect(roleHasPermissions(UserRole.RISK_MANAGER, [Permission.SYSTEM_KILL_SWITCH])).toBe(true);
    expect(roleHasPermissions(UserRole.RISK_MANAGER, [Permission.RISK_MANAGE])).toBe(true);
    expect(roleHasPermissions(UserRole.RISK_MANAGER, [Permission.AUDIT_READ])).toBe(true);
    // But not the ability to reassign who oversees whom.
    expect(roleHasPermissions(UserRole.RISK_MANAGER, [Permission.MASTER_MANAGE])).toBe(false);
  });

  /**
   * Deliberate, and easy to mistake for an oversight: an administrator manages
   * who may act, not the trades themselves. Placing or closing a trade on
   * someone else's account is operator work, granted per master-account link,
   * so that it leaves a record naming a person rather than a role.
   */
  it('does not let an administrator trade another person’s account', () => {
    expect(roleHasPermissions(UserRole.ADMIN, [Permission.MASTER_MANAGE])).toBe(true);
    expect(roleHasPermissions(UserRole.ADMIN, [Permission.ORDERS_CREATE])).toBe(false);
    expect(roleHasPermissions(UserRole.ADMIN, [Permission.POSITIONS_CLOSE])).toBe(false);
    expect(roleHasPermissions(UserRole.ADMIN, [Permission.POSITIONS_MODIFY])).toBe(false);
  });
});

describe('the catalogue itself', () => {
  it('covers every role', () => {
    for (const role of Object.values(UserRole)) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  it('grants no permission that is not in the catalogue', () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of granted) {
        expect(known.has(permission), `${role} is granted unknown ${permission}`).toBe(true);
      }
    }
  });

  /** A permission nobody can hold is either a mistake or dead weight. */
  it('leaves no permission ungranted to every role', () => {
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    const orphaned = ALL_PERMISSIONS.filter((permission) => !granted.has(permission));
    expect(orphaned).toEqual([]);
  });

  it('grants each role a distinct set', () => {
    const signatures = Object.values(ROLE_PERMISSIONS).map((set) => [...set].sort().join('|'));
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('lists no duplicates within a role', () => {
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set(granted).size, `${role} repeats a permission`).toBe(granted.length);
    }
  });

  it('reports a role’s own set', () => {
    expect(permissionsFor(UserRole.USER)).toContain(Permission.ORDERS_CREATE);
  });
});
