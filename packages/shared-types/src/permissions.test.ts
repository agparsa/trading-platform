import { describe, expect, it } from 'vitest';
import { TenantKind, UserRole, rolesForTenantKind } from './enums/account';
import { ROLE_ALIASES, seedRoles } from './role-seed';
import {
  ALL_PERMISSIONS,
  Permission,
  permissionsFor,
  ROLE_PERMISSIONS,
  roleHasPermissions,
  isLinkableCapability,
  conflictsIn,
  escalationsIn,
  isPermission,
  KEYABLE_PERMISSIONS,
  PERSON_ONLY_PERMISSIONS,
  SERVICE_GRANTABLE_PERMISSIONS,
  isKeyable,
  isServiceGrantable,
  LINKABLE_CAPABILITIES,
  MASTER_ROLE_CAPABILITIES,
  MasterRole,
  isMasterRole,
  masterRoleOf,
} from './permissions';

/**
 * The three roles built on the administrator's set: the administrator, the
 * firm's owner, and the platform's super administrator. Where a test says
 * "only an administrator", it means these.
 */
const ADMINISTRATORS: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.BROKER_OWNER,
  UserRole.PLATFORM_SUPER_ADMIN,
];

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

describe('instrument capabilities', () => {
  /**
   * Changing an instrument's terms is not an on/off switch. Raising a margin
   * rate changes the margin required by every position already open in it, and
   * can put an account into margin call without anyone touching that account.
   * Administrators only.
   */
  it('lets only an administrator change what the platform trades', () => {
    for (const role of Object.values(UserRole)) {
      const may = roleHasPermissions(role, [Permission.INSTRUMENTS_MANAGE]);
      const should = ADMINISTRATORS.includes(role);
      expect(may, `${role} should ${should ? '' : 'not '}manage instruments`).toBe(should);
    }
  });

  it('lets the operational roles read them', () => {
    for (const role of [UserRole.OPERATOR, UserRole.RISK_MANAGER, UserRole.ADMIN]) {
      expect(roleHasPermissions(role, [Permission.INSTRUMENTS_READ])).toBe(true);
    }
    expect(roleHasPermissions(UserRole.USER, [Permission.INSTRUMENTS_READ])).toBe(false);
  });

  /**
   * A master-account link is a trading delegation. Nothing that reconfigures
   * the platform belongs in one, however the link was worded.
   */
  it('never lets a master-account link carry either of them', () => {
    expect(isLinkableCapability(Permission.INSTRUMENTS_MANAGE)).toBe(false);
    expect(isLinkableCapability(Permission.INSTRUMENTS_READ)).toBe(false);
  });
});

describe('reconciliation capabilities', () => {
  /**
   * The defect this describes: `reconciliation.read` and the finding-status
   * write were once the same permission, so an `OPERATOR` who could see a money
   * discrepancy could also declare it a false positive. Closing a finding is
   * the act that makes a discrepancy stop being visible, which is exactly the
   * act that should not sit behind a permission called read.
   */
  it('lets the operational roles see findings', () => {
    for (const role of [UserRole.OPERATOR, UserRole.RISK_MANAGER, UserRole.ADMIN]) {
      expect(roleHasPermissions(role, [Permission.RECONCILIATION_READ])).toBe(true);
    }
  });

  it('does not let an operator decide what a finding means', () => {
    expect(roleHasPermissions(UserRole.OPERATOR, [Permission.RECONCILIATION_READ])).toBe(true);
    expect(roleHasPermissions(UserRole.OPERATOR, [Permission.RECONCILIATION_MANAGE])).toBe(false);
  });

  it('gives the decision to risk management and administration', () => {
    for (const role of [UserRole.RISK_MANAGER, UserRole.ADMIN]) {
      expect(roleHasPermissions(role, [Permission.RECONCILIATION_MANAGE])).toBe(true);
    }
  });

  it('keeps a trader out of all of it', () => {
    for (const permission of [
      Permission.RECONCILIATION_READ,
      Permission.RECONCILIATION_MANAGE,
      Permission.RECONCILIATION_RUN,
    ]) {
      expect(roleHasPermissions(UserRole.USER, [permission])).toBe(false);
    }
  });

  it('never lets a master-account link carry any of them', () => {
    // A link delegates trading on one account. Reconciliation is platform-wide.
    for (const permission of [
      Permission.RECONCILIATION_READ,
      Permission.RECONCILIATION_MANAGE,
      Permission.RECONCILIATION_RUN,
    ]) {
      expect(isLinkableCapability(permission)).toBe(false);
    }
  });
});

describe('invitations', () => {
  /**
   * Inviting someone in and acting on someone already here are different
   * powers. A support role that can suspend an account should not thereby be
   * able to create the next hundred.
   */
  it('is an administrator capability alone', () => {
    for (const role of Object.values(UserRole)) {
      expect(roleHasPermissions(role, [Permission.INVITES_MANAGE])).toBe(
        ADMINISTRATORS.includes(role),
      );
    }
  });

  it('is not delegable through a master-account link', () => {
    expect(isLinkableCapability(Permission.INVITES_MANAGE)).toBe(false);
  });
});

describe('an administrator is not a trader', () => {
  /**
   * The rule that surprises everyone once, and the reason it exists: an
   * administrator can post to the ledger and change an instrument's margin
   * rate. One who could also trade could credit an account and trade the
   * credit. Someone who needs to do both holds two logins.
   */
  it('gives ADMIN no way to place or close a trade, on any account', () => {
    for (const capability of [
      Permission.ORDERS_CREATE,
      Permission.ORDERS_MODIFY,
      Permission.POSITIONS_CLOSE,
      Permission.POSITIONS_MODIFY,
    ]) {
      expect(
        roleHasPermissions(UserRole.ADMIN, [capability]),
        `ADMIN must not carry ${capability}`,
      ).toBe(false);
    }
  });

  /** And the two capabilities that make trading dangerous for an admin to hold. */
  it('gives ADMIN the money and configuration powers that are the reason why', () => {
    expect(roleHasPermissions(UserRole.ADMIN, [Permission.ACCOUNTS_ADJUST])).toBe(true);
    expect(roleHasPermissions(UserRole.ADMIN, [Permission.INSTRUMENTS_MANAGE])).toBe(true);
  });

  it('leaves the ordinary trader able to trade', () => {
    expect(
      roleHasPermissions(UserRole.USER, [Permission.ORDERS_CREATE, Permission.POSITIONS_CLOSE]),
    ).toBe(true);
  });

  /**
   * The documented way for an administrator to act on an account: a
   * master-account link, granted per account, leaving a record.
   */
  it('allows trading to be delegated per account through a link', () => {
    expect(isLinkableCapability(Permission.ORDERS_CREATE)).toBe(true);
    expect(isLinkableCapability(Permission.POSITIONS_CLOSE)).toBe(true);
  });
});

describe('combinations no single role may hold', () => {
  it('finds the pair that lets someone invent money and then trade it', () => {
    expect(conflictsIn([Permission.ACCOUNTS_ADJUST, Permission.ORDERS_CREATE])).toEqual([
      [Permission.ACCOUNTS_ADJUST, Permission.ORDERS_CREATE],
    ]);
  });

  it('finds every conflicting pair, not the first', () => {
    expect(
      conflictsIn([
        Permission.ACCOUNTS_ADJUST,
        Permission.ORDERS_CREATE,
        Permission.ORDERS_MODIFY,
        Permission.POSITIONS_MODIFY,
      ]),
    ).toHaveLength(3);
  });

  it('allows either half on its own', () => {
    expect(conflictsIn([Permission.ACCOUNTS_ADJUST])).toEqual([]);
    expect(conflictsIn([Permission.ORDERS_CREATE, Permission.ORDERS_MODIFY])).toEqual([]);
  });

  /**
   * Stopping something is not starting it — the same distinction that lets
   * ADMIN keep `orders.cancel` while not holding `orders.create`.
   */
  it('allows adjusting alongside cancelling and closing', () => {
    expect(
      conflictsIn([
        Permission.ACCOUNTS_ADJUST,
        Permission.ORDERS_CANCEL,
        Permission.POSITIONS_CLOSE,
      ]),
    ).toEqual([]);
  });

  /**
   * The seeded roles are the thing this rule was written about. If one of them
   * violated it, the platform could not seed itself — so this is the test that
   * fails first when somebody widens ADMIN.
   */
  it.each(Object.values(UserRole))('is satisfied by the built-in role %s', (role) => {
    expect(conflictsIn(permissionsFor(role))).toEqual([]);
  });
});

describe('the wallet capabilities', () => {
  /**
   * `wallet.adjust` is `accounts.adjust` aimed at a different pot. Money
   * invented in a wallet reaches a position through one transfer, and the holder
   * is entitled to make that transfer on their own wallet.
   */
  it.each([Permission.ORDERS_CREATE, Permission.ORDERS_MODIFY, Permission.POSITIONS_MODIFY])(
    'cannot sit in one role with %s',
    (trading) => {
      expect(conflictsIn([Permission.WALLET_ADJUST, trading])).toHaveLength(1);
    },
  );

  it('may sit beside freezing a wallet, which holds money rather than making it', () => {
    expect(conflictsIn([Permission.WALLET_ADJUST, Permission.WALLET_MANAGE])).toEqual([]);
  });

  /**
   * A trader moves their own money and reads their own wallet, and does neither
   * to anybody else's — the same split as `accounts.read` and
   * `accounts.read_any`, and for the same reason.
   */
  it('gives a trader their own wallet and not everyone eles\u2019s', () => {
    const trader = permissionsFor(UserRole.USER);
    expect(trader).toContain(Permission.WALLET_READ);
    expect(trader).toContain(Permission.WALLET_TRANSFER);
    expect(trader).not.toContain(Permission.WALLET_READ_ANY);
    expect(trader).not.toContain(Permission.WALLET_ADJUST);
  });

  it('lets support read wallets and change nothing', () => {
    const support = permissionsFor(UserRole.SUPPORT);
    expect(support).toContain(Permission.WALLET_READ_ANY);
    expect(support).not.toContain(Permission.WALLET_ADJUST);
    expect(support).not.toContain(Permission.WALLET_MANAGE);
    expect(support).not.toContain(Permission.WALLET_TRANSFER);
  });

  /**
   * A risk manager freezes a wallet during a review and cannot change what is in
   * it. Holding money and taking it are different powers and the audit trail
   * should be able to say which happened.
   */
  it('lets a risk manager freeze a wallet without being able to adjust it', () => {
    const risk = permissionsFor(UserRole.RISK_MANAGER);
    expect(risk).toContain(Permission.WALLET_MANAGE);
    expect(risk).not.toContain(Permission.WALLET_ADJUST);
  });

  it('does not let an administrator move somebody else\u2019s money into a position', () => {
    const admin = permissionsFor(UserRole.ADMIN);
    expect(admin).toContain(Permission.WALLET_ADJUST);
    expect(admin).not.toContain(Permission.WALLET_TRANSFER);
    expect(admin).not.toContain(Permission.ORDERS_CREATE);
  });

  /**
   * A master-account link is authority over one trading account. A wallet is not
   * a trading account, and nothing about "act on this account" should reach the
   * money that has not been put into it.
   */
  it('is never delegable through a master-account link', () => {
    for (const capability of [
      Permission.WALLET_READ,
      Permission.WALLET_READ_ANY,
      Permission.WALLET_TRANSFER,
      Permission.WALLET_ADJUST,
      Permission.WALLET_MANAGE,
    ]) {
      expect(isLinkableCapability(capability)).toBe(false);
    }
  });
});

describe('what an editor may grant', () => {
  it('reports what the grant contains that the editor does not hold', () => {
    expect(
      escalationsIn(
        [Permission.ACCOUNTS_ADJUST, Permission.ORDERS_READ],
        [Permission.ORDERS_READ, Permission.POSITIONS_READ],
      ),
    ).toEqual([Permission.ACCOUNTS_ADJUST]);
  });

  it('allows granting a subset of what the editor holds', () => {
    expect(escalationsIn([Permission.ORDERS_READ], permissionsFor(UserRole.ADMIN))).toEqual([]);
  });

  /**
   * The rule is about the result, not the diff. An editor removing something
   * they themselves lack is narrowing a role, which nobody needs permission to
   * do beyond `roles.manage` itself.
   */
  it('says nothing about capabilities being removed', () => {
    expect(escalationsIn([], [Permission.ORDERS_READ])).toEqual([]);
  });

  it('does not report the same escalation twice', () => {
    expect(escalationsIn([Permission.RISK_MANAGE, Permission.RISK_MANAGE], [])).toEqual([
      Permission.RISK_MANAGE,
    ]);
  });

  /**
   * An ADMIN cannot grant a role `orders.create`, because ADMIN does not hold
   * it — so the two rules overlap here, and that is deliberate. The conflict
   * rule catches an editor who *does* hold both; this one catches the ordinary
   * administrator who does not.
   */
  it('stops an administrator granting the one capability their own role lacks', () => {
    expect(escalationsIn([Permission.ORDERS_CREATE], permissionsFor(UserRole.ADMIN))).toEqual([
      Permission.ORDERS_CREATE,
    ]);
  });
});

describe('isPermission', () => {
  it('accepts every capability this build defines', () => {
    expect(ALL_PERMISSIONS.every((permission) => isPermission(permission))).toBe(true);
  });

  it.each([
    'orders.creat',
    'orders.*',
    '',
    'ORDERS_CREATE',
    'accounts.read; drop table users',
    '__proto__',
    'constructor',
  ])('refuses %j', (value) => {
    expect(isPermission(value)).toBe(false);
  });
});

describe('programmatic access', () => {
  it('lets every person manage their own keys, and staff see and revoke them', () => {
    expect(roleHasPermissions(UserRole.USER, [Permission.API_KEYS_MANAGE])).toBe(true);
    expect(roleHasPermissions(UserRole.SUPPORT, [Permission.API_KEYS_READ_ANY])).toBe(true);
    expect(roleHasPermissions(UserRole.SUPPORT, [Permission.API_KEYS_REVOKE_ANY])).toBe(false);
    expect(roleHasPermissions(UserRole.RISK_MANAGER, [Permission.API_KEYS_REVOKE_ANY])).toBe(true);
    expect(roleHasPermissions(UserRole.ADMIN, [Permission.API_KEYS_REVOKE_ANY])).toBe(true);
  });

  it('lets only an administrator or a developer mint a machine identity', () => {
    const minters = [...ADMINISTRATORS, UserRole.BROKER_DEVELOPER, UserRole.PLATFORM_DEVELOPER];
    for (const role of Object.values(UserRole)) {
      expect(roleHasPermissions(role, [Permission.SERVICE_TOKENS_MANAGE])).toBe(
        minters.includes(role),
      );
    }
  });

  it('partitions the catalogue: every capability is keyable or person-only, never both', () => {
    const union = new Set([...KEYABLE_PERMISSIONS, ...PERSON_ONLY_PERMISSIONS]);
    expect(union.size).toBe(ALL_PERMISSIONS.length);
    expect(KEYABLE_PERMISSIONS.filter((p) => PERSON_ONLY_PERMISSIONS.includes(p))).toEqual([]);
  });

  it('keeps money, roles and keys themselves out of a key', () => {
    for (const forbidden of [
      Permission.ACCOUNTS_ADJUST,
      Permission.WALLET_ADJUST,
      Permission.PAYMENTS_CONFIRM,
      Permission.WITHDRAWALS_REQUEST,
      Permission.WITHDRAWALS_REVIEW,
      Permission.WITHDRAWALS_PAY,
      Permission.KYC_DOCUMENTS_READ,
      Permission.ROLES_ASSIGN,
      Permission.ROLES_MANAGE,
      Permission.USERS_MANAGE,
      Permission.API_KEYS_MANAGE,
      Permission.SERVICE_TOKENS_MANAGE,
      Permission.SYSTEM_KILL_SWITCH,
    ]) {
      expect(isKeyable(forbidden)).toBe(false);
    }
  });

  it('lets a key trade and read, which is what a key is for', () => {
    for (const allowed of [
      Permission.ORDERS_CREATE,
      Permission.ORDERS_CANCEL,
      Permission.POSITIONS_CLOSE,
      Permission.POSITIONS_READ,
      Permission.ACCOUNTS_READ,
      Permission.WALLET_READ,
      Permission.ACCOUNTS_READ_ANY,
      Permission.RISK_READ,
    ]) {
      expect(isKeyable(allowed)).toBe(true);
    }
  });

  it('lets a service token read across the tenant and write nothing', () => {
    expect(SERVICE_GRANTABLE_PERMISSIONS.length).toBeGreaterThan(0);
    for (const permission of SERVICE_GRANTABLE_PERMISSIONS) {
      expect(permission.endsWith('.read') || permission.endsWith('.read_any')).toBe(true);
      // No "mine": a token has none.
      expect(
        [
          Permission.ACCOUNTS_READ,
          Permission.WALLET_READ,
          Permission.PAYMENTS_READ,
          Permission.KYC_READ,
          Permission.WITHDRAWALS_READ,
          Permission.ORDERS_READ,
          Permission.POSITIONS_READ,
        ].includes(permission),
      ).toBe(false);
    }
    expect(isServiceGrantable(Permission.ACCOUNTS_MANAGE)).toBe(false);
    expect(isServiceGrantable(Permission.ORDERS_CREATE)).toBe(false);
    expect(isServiceGrantable(Permission.ACCOUNTS_READ_ANY)).toBe(true);
  });

  it('gives an administrator everything a service token may carry, so the subset rule can hold', () => {
    // A token may carry only what its minter holds; if ADMIN lacked one of
    // these, no token could ever carry it and the list would be a lie.
    expect(roleHasPermissions(UserRole.ADMIN, SERVICE_GRANTABLE_PERMISSIONS)).toBe(true);
  });
});

describe('role groups', () => {
  it('seeds platform roles on the platform tenant only', () => {
    const broker = rolesForTenantKind(TenantKind.BROKER);
    const platform = rolesForTenantKind(TenantKind.PLATFORM);
    expect(broker).not.toContain(UserRole.PLATFORM_SUPER_ADMIN);
    expect(broker).toContain(UserRole.BROKER_OWNER);
    expect(broker).toContain(UserRole.USER);
    expect(platform).toEqual(Object.values(UserRole));
    expect(seedRoles(TenantKind.BROKER).map((role) => role.key)).toEqual(broker);
  });

  it('keeps the platform-only capabilities out of every broker role', () => {
    for (const role of rolesForTenantKind(TenantKind.BROKER)) {
      expect(roleHasPermissions(role, [Permission.TENANTS_MANAGE])).toBe(false);
      expect(roleHasPermissions(role, [Permission.TENANTS_READ])).toBe(false);
    }
    expect(roleHasPermissions(UserRole.PLATFORM_SUPER_ADMIN, [Permission.TENANTS_MANAGE])).toBe(
      true,
    );
    expect(roleHasPermissions(UserRole.PLATFORM_OPERATOR, [Permission.TENANTS_MANAGE])).toBe(true);
    expect(roleHasPermissions(UserRole.PLATFORM_AUDITOR, [Permission.TENANTS_MANAGE])).toBe(false);
  });

  it('binds the owner and the super administrator by the same separations as the administrator', () => {
    for (const role of [UserRole.BROKER_OWNER, UserRole.PLATFORM_SUPER_ADMIN]) {
      expect(roleHasPermissions(role, [Permission.ORDERS_CREATE])).toBe(false);
      expect(roleHasPermissions(role, [Permission.WITHDRAWALS_REVIEW])).toBe(false);
      expect(conflictsIn(permissionsFor(role))).toEqual([]);
    }
  });

  it('gives the read-only roles no way to write', () => {
    const writes = ALL_PERMISSIONS.filter(
      (p) => !p.endsWith('.read') && !p.endsWith('.read_any') && p !== Permission.API_KEYS_MANAGE,
    );
    for (const role of [
      UserRole.BROKER_ANALYST,
      UserRole.PLATFORM_AUDITOR,
      UserRole.PLATFORM_SUPPORT,
    ]) {
      for (const permission of writes) {
        expect(roleHasPermissions(role, [permission]), `${role} holds ${permission}`).toBe(false);
      }
    }
  });

  it('names the specification’s roles that this repository keys differently', () => {
    expect(ROLE_ALIASES['BROKER_ADMIN']).toBe(UserRole.ADMIN);
    expect(ROLE_ALIASES['TRADING_USER']).toBe(UserRole.USER);
    for (const key of Object.values(ROLE_ALIASES)) expect(Object.values(UserRole)).toContain(key);
  });
});

describe('master-account role presets', () => {
  it('never expands to anything the linkable ceiling refuses', () => {
    for (const [role, capabilities] of Object.entries(MASTER_ROLE_CAPABILITIES)) {
      for (const capability of capabilities) {
        expect(
          isLinkableCapability(capability),
          `${role} would delegate ${capability}, which no link may carry`,
        ).toBe(true);
      }
    }
  });

  it('is a ladder: each preset contains the one below it', () => {
    const ladder = [
      MasterRole.MASTER_VIEWER,
      MasterRole.MASTER_TRADER,
      MasterRole.MASTER_MANAGER,
      MasterRole.MASTER_OWNER,
    ];
    for (let i = 1; i < ladder.length; i += 1) {
      const lower = new Set<string>(MASTER_ROLE_CAPABILITIES[ladder[i - 1]!]);
      const higher = new Set<string>(MASTER_ROLE_CAPABILITIES[ladder[i]!]);
      for (const capability of lower) {
        expect(
          higher.has(capability),
          `${ladder[i]} does not contain ${capability}, which ${ladder[i - 1]} grants`,
        ).toBe(true);
      }
      expect(higher.size).toBeGreaterThanOrEqual(lower.size);
    }
  });

  /**
   * Today the ceiling is exactly the manager set, so the top two presets
   * coincide. That is a fact about the ceiling, not an alias: this test fails
   * the moment they diverge, which is the moment someone should check that a
   * newly linkable capability really belongs to an owner and not a manager.
   */
  it('has three distinct rungs today, with owner and manager coinciding', () => {
    const sizes = [
      MasterRole.MASTER_VIEWER,
      MasterRole.MASTER_TRADER,
      MasterRole.MASTER_MANAGER,
      MasterRole.MASTER_OWNER,
    ].map((role) => MASTER_ROLE_CAPABILITIES[role].length);
    expect(sizes).toEqual([4, 9, 10, 10]);
    // And they are separate definitions, not the same array: a capability
    // added to the ceiling must reach the owner without reaching the manager.
    expect(MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_MANAGER]).not.toBe(
      MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_OWNER],
    );
  });

  it('lets a viewer see and nothing else — the distinction the preset exists for', () => {
    const viewer = new Set<string>(MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_VIEWER]);
    for (const capability of [
      Permission.ORDERS_CREATE,
      Permission.ORDERS_CANCEL,
      Permission.ORDERS_MODIFY,
      Permission.POSITIONS_CLOSE,
      Permission.POSITIONS_MODIFY,
      Permission.ACCOUNTS_MANAGE,
    ]) {
      expect(viewer.has(capability), `a viewer must not be able to ${capability}`).toBe(false);
    }
  });

  it('lets a trader trade but not change the account it trades', () => {
    const trader = new Set<string>(MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_TRADER]);
    expect(trader.has(Permission.ORDERS_CREATE)).toBe(true);
    expect(trader.has(Permission.POSITIONS_CLOSE)).toBe(true);
    // Changing an account's own settings is management, not trading.
    expect(trader.has(Permission.ACCOUNTS_MANAGE)).toBe(false);
  });

  it('the top preset is the ceiling itself, so widening the ceiling cannot leave it behind', () => {
    expect([...MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_OWNER]].sort()).toEqual(
      [...LINKABLE_CAPABILITIES].sort(),
    );
  });

  it('names a capability list that is exactly a preset, and refuses to round one that is not', () => {
    expect(masterRoleOf(MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_TRADER])).toBe(
      MasterRole.MASTER_TRADER,
    );
    expect(masterRoleOf([...MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_VIEWER]].reverse())).toBe(
      MasterRole.MASTER_VIEWER,
    );
    // One capability short of a trader is not a trader, and is not a viewer either.
    expect(
      masterRoleOf(
        MASTER_ROLE_CAPABILITIES[MasterRole.MASTER_TRADER].filter(
          (one) => one !== Permission.ORDERS_CANCEL,
        ),
      ),
    ).toBe(null);
    expect(masterRoleOf([])).toBe(null);
  });

  it('recognises its own names and nothing else', () => {
    expect(isMasterRole('MASTER_TRADER')).toBe(true);
    expect(isMasterRole('ADMIN')).toBe(false);
    expect(isMasterRole('MASTER_SUPERUSER')).toBe(false);
  });
});
