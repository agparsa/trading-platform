import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  DomainError,
  Permission,
  TradingErrorCode,
  UserRole,
  permissionsFor,
} from '@tp/shared-types';
import { RolesService } from '../../src/permissions/roles.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { DEFAULT_TENANT_ID, createTestClient, hasTestDatabase, resetDatabase } from './harness';
import { seedTenantRoles } from '../../../../prisma/roles';

const suite = hasTestDatabase ? describe : describe.skip;

/** Redis stands in: what matters here is what reaches the database and the cache. */
function redisStub(): { published: string[]; service: unknown } {
  const published: string[] = [];
  return {
    published,
    service: {
      publisher: {
        publish: (_channel: string, message: string) => {
          published.push(message);
          return Promise.resolve(1);
        },
      },
      subscriber: { subscribe: () => Promise.resolve(), on: () => undefined },
    },
  };
}

suite('roles and grants as data', () => {
  let prisma: PrismaClient;
  let roles: RolesService;
  let published: string[];
  let ADMIN: { id: string; role: string };

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    const editor = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: 'admin@test.local',
        passwordHash: 'not-a-real-hash',
        displayName: 'Admin',
        role: UserRole.ADMIN,
      },
    });
    ADMIN = { id: editor.id, role: UserRole.ADMIN };
    const redis = redisStub();
    published = redis.published;
    roles = new RolesService(
      prisma as unknown as PrismaService,
      redis.service as never,
      new AuditService(prisma as unknown as PrismaService),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * The migration's seed was generated from `ROLE_PERMISSIONS` rather than
   * transcribed, and it still drifted once during this phase: the generator ran
   * against a stale build and wrote two capabilities fewer than the constant
   * held. Nothing failed. This is the check that would have failed.
   */
  it.each(Object.values(UserRole))(
    'seeds %s with exactly what the compile-time constant says',
    async (role) => {
      const held = await roles.permissionsFor(role);
      expect([...held].sort()).toEqual([...permissionsFor(role)].sort());
    },
  );

  it('answers from the rows, not from the constant', async () => {
    await roles.setPermissions(UserRole.SUPPORT, [Permission.AUDIT_READ], ADMIN);

    const held = await roles.permissionsFor(UserRole.SUPPORT);
    expect([...held]).toEqual([Permission.AUDIT_READ]);
    // And the constant is unchanged, so the difference is real rather than a
    // test that mutated a shared object.
    expect(permissionsFor(UserRole.SUPPORT)).toContain(Permission.ACCOUNTS_READ_ANY);
  });

  it('takes effect immediately rather than at the next cache expiry', async () => {
    expect(await roles.permissionsFor(UserRole.SUPPORT)).toContain(Permission.ACCOUNTS_READ_ANY);
    await roles.setPermissions(UserRole.SUPPORT, [], ADMIN);
    expect(await roles.permissionsFor(UserRole.SUPPORT)).not.toContain(
      Permission.ACCOUNTS_READ_ANY,
    );
  });

  it('tells the other instances to drop their copy', async () => {
    await roles.setPermissions(UserRole.SUPPORT, [], ADMIN);
    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0] ?? '{}')).toMatchObject({ tenantId: expect.any(String) });
  });

  /**
   * The rule the plan demanded be decided in this phase rather than discovered
   * later. Someone will try this on a Tuesday afternoon.
   */
  it('refuses to put accounts.adjust and orders.create in one role', async () => {
    const attempt = roles.setPermissions(
      UserRole.SUPPORT,
      [Permission.ACCOUNTS_ADJUST, Permission.ORDERS_CREATE],
      ADMIN,
    );
    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    // And nothing was written.
    expect(await roles.permissionsFor(UserRole.SUPPORT)).toContain(Permission.ACCOUNTS_READ_ANY);
  });

  it('allows either half of that pair on its own', async () => {
    await roles.setPermissions(UserRole.SUPPORT, [Permission.ACCOUNTS_ADJUST], ADMIN);
    expect(await roles.permissionsFor(UserRole.SUPPORT)).toEqual(
      new Set([Permission.ACCOUNTS_ADJUST]),
    );
  });

  /**
   * `roles.manage` is the meta-permission and the reason this phase adds a new
   * way to escalate. The bound is the oldest one there is.
   */
  it('refuses to grant a capability the editor does not hold', async () => {
    // ADMIN deliberately does not carry orders.create.
    await expect(
      roles.setPermissions(UserRole.SUPPORT, [Permission.ORDERS_CREATE], ADMIN),
    ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
  });

  it('refuses an editor whose own role was narrowed, using the rows rather than the constant', async () => {
    // Narrow ADMIN itself, then try to use what it no longer holds.
    await roles.setPermissions(
      UserRole.ADMIN,
      [Permission.ROLES_READ, Permission.ROLES_MANAGE],
      ADMIN,
    );
    await expect(
      roles.setPermissions(UserRole.SUPPORT, [Permission.AUDIT_READ], ADMIN),
    ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });
  });

  it('refuses a capability name this build does not define', async () => {
    await expect(
      roles.setPermissions(UserRole.SUPPORT, ['orders.*', 'accounts.read'], ADMIN),
    ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
  });

  it('refuses a role that does not exist rather than creating one', async () => {
    await expect(roles.setPermissions('WIZARD', [], ADMIN)).rejects.toMatchObject({
      code: TradingErrorCode.RESOURCE_NOT_FOUND,
    });
    expect(await prisma.role.findFirst({ where: { key: 'WIZARD' } })).toBeNull();
  });

  /**
   * §22: every sensitive operation leaves a record. This one is written inside
   * the transaction, so a change that is not recorded is not a change.
   */
  it('records what changed, both halves', async () => {
    await roles.setPermissions(UserRole.SUPPORT, [Permission.AUDIT_READ], ADMIN);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'role.permissions.changed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).not.toBeNull();
    const before = entry?.before as { permissions: string[] } | null;
    const after = entry?.after as { permissions: string[]; removed: string[] } | null;
    expect(before?.permissions).toContain(Permission.ACCOUNTS_READ_ANY);
    expect(after?.permissions).toEqual([Permission.AUDIT_READ]);
    expect(after?.removed).toContain(Permission.ACCOUNTS_READ_ANY);
  });

  it('leaves no grant behind when the audit write fails', async () => {
    const failing = new AuditService(prisma as unknown as PrismaService);
    failing.record = () => Promise.reject(new Error('audit table unavailable'));
    const service = new RolesService(
      prisma as unknown as PrismaService,
      redisStub().service as never,
      failing,
    );

    await expect(
      service.setPermissions(UserRole.SUPPORT, [Permission.AUDIT_READ], ADMIN),
    ).rejects.toThrow(/audit table unavailable/);

    /**
     * Read from the database, not from `permissionsFor`.
     *
     * Asserting through the service passed even with the audit moved outside the
     * transaction — the grant was written, and the assertion was reading a cache
     * nothing had invalidated. A test whose subject is "the write did not
     * happen" has to ask the thing the write would have happened to.
     */
    const support = await prisma.role.findFirst({
      where: { key: UserRole.SUPPORT },
      include: { permissions: { select: { permission: true } } },
    });
    expect(support?.permissions.map((grant) => grant.permission)).toContain(
      Permission.ACCOUNTS_READ_ANY,
    );
  });

  it('reports a role that was emptied as holding nothing, not as holding the default', async () => {
    await roles.setPermissions(UserRole.SUPPORT, [], ADMIN);
    expect(await roles.permissionsFor(UserRole.SUPPORT)).toEqual(new Set());
  });

  /**
   * A tenant with roles but not this one had it deleted, which was a decision.
   * Restoring the code default would make deletion do nothing.
   */
  it('gives a deleted role nothing rather than its compile-time default', async () => {
    const support = await prisma.role.findFirst({ where: { key: UserRole.SUPPORT } });
    await prisma.role.delete({ where: { id: support?.id ?? '' } });
    await roles.invalidate((await prisma.tenant.findFirst())?.id ?? '');

    expect(await roles.permissionsFor(UserRole.SUPPORT)).toEqual(new Set());
    // Other roles are unaffected.
    expect(await roles.permissionsFor(UserRole.ADMIN)).toContain(Permission.AUDIT_READ);
  });

  /**
   * A tenant with *no* roles never got seeded — infrastructure, not a decision —
   * and denying everything would take the firm offline over it.
   */
  it('falls back to the compile-time grants when a tenant has no roles at all', async () => {
    await prisma.rolePermission.deleteMany({});
    await prisma.role.deleteMany({});
    await roles.invalidate((await prisma.tenant.findFirst())?.id ?? '');

    expect([...(await roles.permissionsFor(UserRole.ADMIN))].sort()).toEqual(
      [...permissionsFor(UserRole.ADMIN)].sort(),
    );
  });

  /**
   * The seed runs on every deploy, and has to answer two questions at once:
   * did a release add a capability the roles nobody has edited should get, and
   * did an operator narrow a role that must be left exactly as they left it?
   */
  describe('what a deploy does to existing roles', () => {
    it('creates a role that is missing entirely', async () => {
      const tenantId = (await prisma.tenant.findFirst())?.id ?? '';
      const operator = await prisma.role.findFirst({ where: { key: UserRole.OPERATOR } });
      await prisma.role.delete({ where: { id: operator?.id ?? '' } });

      const result = await seedTenantRoles(prisma, tenantId);

      expect(result.created).toBe(1);
      await roles.invalidate(tenantId);
      expect(await roles.permissionsFor(UserRole.OPERATOR)).toContain(Permission.SYSTEM_OPERATIONS);
    });

    /**
     * The case that made this exist. A release that adds `wallet.read` to the
     * trader role could not previously reach a tenant, so the feature worked in
     * the tests and answered 403 in production — which is exactly how the wallet
     * phase's pentest probe failed.
     */
    it('brings an untouched built-in role in line with this build', async () => {
      const tenantId = (await prisma.tenant.findFirst())?.id ?? '';
      const user = await prisma.role.findFirstOrThrow({ where: { key: UserRole.USER } });
      await prisma.rolePermission.deleteMany({
        where: { roleId: user.id, permission: Permission.WALLET_READ },
      });
      await roles.invalidate(tenantId);
      expect(await roles.permissionsFor(UserRole.USER)).not.toContain(Permission.WALLET_READ);

      const result = await seedTenantRoles(prisma, tenantId);

      expect(result.refreshed).toBe(1);
      await roles.invalidate(tenantId);
      expect(await roles.permissionsFor(UserRole.USER)).toContain(Permission.WALLET_READ);
    });

    /**
     * And the asymmetry. A deploy that silently re-widened a role somebody had
     * narrowed would be the worst kind of regression: nothing about it would
     * look wrong.
     */
    /**
     * A release that *swaps* a capability — one removed, one added — leaves the
     * count unchanged. Comparing sizes alone passed every other test here and
     * would have missed it, which is why this one exists.
     */
    it('notices a swap that leaves the count the same', async () => {
      const tenantId = (await prisma.tenant.findFirst())?.id ?? '';
      const user = await prisma.role.findFirstOrThrow({ where: { key: UserRole.USER } });
      await prisma.rolePermission.deleteMany({
        where: { roleId: user.id, permission: Permission.WALLET_READ },
      });
      await prisma.rolePermission.create({
        data: { tenantId, roleId: user.id, permission: Permission.AUDIT_READ },
      });
      await roles.invalidate(tenantId);

      const result = await seedTenantRoles(prisma, tenantId);

      expect(result.refreshed).toBe(1);
      await roles.invalidate(tenantId);
      const held = await roles.permissionsFor(UserRole.USER);
      expect(held).toContain(Permission.WALLET_READ);
      expect(held).not.toContain(Permission.AUDIT_READ);
    });

    it('leaves a role somebody edited exactly as they left it', async () => {
      const tenantId = (await prisma.tenant.findFirst())?.id ?? '';
      await roles.setPermissions(UserRole.SUPPORT, [], ADMIN);

      const result = await seedTenantRoles(prisma, tenantId);

      expect(result.refreshed).toBe(0);
      await roles.invalidate(tenantId);
      expect(await roles.permissionsFor(UserRole.SUPPORT)).toEqual(new Set());
    });

    it('records that it was edited, and forgets again when it is restored', async () => {
      const tenantId = (await prisma.tenant.findFirst())?.id ?? '';
      await roles.setPermissions(UserRole.SUPPORT, [], ADMIN);
      expect(
        (await prisma.role.findFirstOrThrow({ where: { key: UserRole.SUPPORT } })).grantsEditedAt,
      ).not.toBeNull();

      await roles.resetToDefaults(UserRole.SUPPORT, ADMIN);
      expect(
        (await prisma.role.findFirstOrThrow({ where: { key: UserRole.SUPPORT } })).grantsEditedAt,
      ).toBeNull();

      // And it tracks the build again from here.
      await prisma.rolePermission.deleteMany({
        where: {
          role: { key: UserRole.SUPPORT, tenantId },
          permission: Permission.WALLET_READ_ANY,
        },
      });
      expect((await seedTenantRoles(prisma, tenantId)).refreshed).toBe(1);
    });

    it('does nothing at all when everything already matches', async () => {
      const tenantId = (await prisma.tenant.findFirst())?.id ?? '';
      expect(await seedTenantRoles(prisma, tenantId)).toEqual({ created: 0, refreshed: 0 });
    });
  });

  describe('restoring a built-in role', () => {
    it('puts back exactly what this build ships', async () => {
      await roles.setPermissions(UserRole.SUPPORT, [], ADMIN);
      await roles.resetToDefaults(UserRole.SUPPORT, ADMIN);
      expect([...(await roles.permissionsFor(UserRole.SUPPORT))].sort()).toEqual(
        [...permissionsFor(UserRole.SUPPORT)].sort(),
      );
    });

    /**
     * The reason this is not a button inside the editor. `USER` carries
     * `orders.create`; `ADMIN` deliberately does not, so the escalation rule
     * would make the default `USER` role permanently unrestorable by anyone.
     */
    it('restores a capability no administrator could grant by hand', async () => {
      await roles.setPermissions(UserRole.USER, [], ADMIN);
      await expect(
        roles.setPermissions(UserRole.USER, [Permission.ORDERS_CREATE], ADMIN),
      ).rejects.toMatchObject({ code: TradingErrorCode.FORBIDDEN });

      await roles.resetToDefaults(UserRole.USER, ADMIN);
      expect(await roles.permissionsFor(UserRole.USER)).toContain(Permission.ORDERS_CREATE);
    });

    it('records the reset with both halves', async () => {
      await roles.setPermissions(UserRole.SUPPORT, [], ADMIN);
      await roles.resetToDefaults(UserRole.SUPPORT, ADMIN);
      const entry = await prisma.auditLog.findFirst({
        where: { action: 'role.permissions.reset' },
        orderBy: { createdAt: 'desc' },
      });
      expect((entry?.before as { permissions: string[] } | null)?.permissions).toEqual([]);
      expect((entry?.after as { permissions: string[] } | null)?.permissions).toContain(
        Permission.ACCOUNTS_READ_ANY,
      );
    });

    it('refuses a role this build does not ship', async () => {
      await expect(roles.resetToDefaults('WIZARD', ADMIN)).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
    });

    /**
     * A role somebody created has no defaults. Emptying it and calling that
     * "restored" would be a way to disable a role while appearing to fix one.
     */
    it('refuses a role that was created here rather than shipped', async () => {
      const tenantId = (await prisma.tenant.findFirst())?.id ?? '';
      await prisma.role.create({
        data: { tenantId, key: 'DESK_HEAD', name: 'Desk head', isSystem: false },
      });
      await expect(roles.resetToDefaults('DESK_HEAD', ADMIN)).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
    });
  });

  it('lists every role with what it carries', async () => {
    const listed = await roles.list();
    expect(listed.map((role) => role.key).sort()).toEqual([...Object.values(UserRole)].sort());
    expect(listed.every((role) => role.isSystem)).toBe(true);
    expect(listed.find((role) => role.key === UserRole.ADMIN)?.permissions).toContain(
      Permission.ROLES_MANAGE,
    );
  });
});
