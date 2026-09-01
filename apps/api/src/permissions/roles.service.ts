import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  DomainError,
  type Permission,
  TradingErrorCode,
  UserRole,
  conflictsIn,
  escalationsIn,
  isPermission,
  permissionsFor as codePermissionsFor,
  seedRoles,
} from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuditService } from '../common/audit/audit.service';
import { INSTANCE_ID } from '../realtime/events.service';

/** Every instance drops its cached grants when it sees a tenant named here. */
export const ROLE_INVALIDATION_CHANNEL = 'roles:invalidate';

export interface RoleView {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly Permission[];
}

interface TenantRoles {
  readonly byKey: ReadonlyMap<string, ReadonlySet<Permission>>;
  /** True while this entry is known to be behind the database. */
  dirty: boolean;
}

/**
 * What each role in a tenant is allowed to do.
 *
 * ## What moved, and what did not
 *
 * Capabilities are still code. `ALL_PERMISSIONS` is a compile-time constant
 * because code is what checks a capability, and one that exists only as a row is
 * one no route can require. The *grants* are rows, because which role carries
 * which capability is what a firm needs to change without a deployment, and what
 * differs between tenants.
 *
 * ## Why there is a cache at all
 *
 * This is consulted by a global guard, so a database read here is a database
 * read on every authenticated request. The cache holds one entry per tenant —
 * all its roles, loaded in one query — and is dropped when a grant changes, on
 * every instance, over Redis.
 *
 * ## What happens when the database will not answer
 *
 * The guard used to be pure, so it could not fail; now it can, and a permission
 * check that throws is every route returning 500. Two fallbacks, in order:
 *
 *   1. **A previous answer for this tenant**, even a stale one. An administrator
 *      who narrowed a role expects it to stay narrowed, and reverting to the code
 *      defaults on a database blip would silently widen it back.
 *   2. **The code constants**, only if this process has never successfully
 *      loaded that tenant. That is exactly the behaviour before this phase, so
 *      it is not a weakening — but it is logged as an error, because a platform
 *      running on its fallback should not look identical to one that is not.
 *
 * A tenant whose roles are *missing rather than unreadable* is a different case
 * and is treated differently: see `load`.
 */
@Injectable()
export class RolesService implements OnModuleInit {
  private readonly logger = new Logger(RolesService.name);
  private readonly cache = new Map<string, TenantRoles>();
  /** One load per tenant at a time; a cold cache under load must not stampede. */
  private readonly inFlight = new Map<string, Promise<TenantRoles>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.redis.subscriber.subscribe(ROLE_INVALIDATION_CHANNEL);
    this.redis.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== ROLE_INVALIDATION_CHANNEL) return;
      try {
        const message = JSON.parse(raw) as { tenantId?: string; origin?: string };
        if (message.origin === INSTANCE_ID) return; // our own echo
        if (typeof message.tenantId === 'string') this.markDirty(message.tenantId);
      } catch {
        // A message we cannot parse is not a reason to stop enforcing anything.
        this.logger.warn('Ignored an unreadable role-invalidation message');
      }
    });
  }

  /** The capabilities a role carries in the tenant currently in scope. */
  async permissionsFor(roleKey: string): Promise<ReadonlySet<Permission>> {
    const tenantId = requireTenantId();
    const roles = await this.resolve(tenantId);
    /**
     * A role that is not there gets nothing, rather than the code default.
     *
     * The two cases are not alike. A tenant with *no* roles at all never got
     * seeded — infrastructure — and `load` falls back for it. A tenant with
     * roles but not this one had it deleted, which was a decision, and honouring
     * a decision to remove a role by silently restoring its code default would
     * make deletion do nothing.
     */
    return roles.byKey.get(roleKey) ?? new Set<Permission>();
  }

  /** Does this role carry every capability listed? All of them, not any. */
  async roleHasAll(roleKey: string, required: readonly Permission[]): Promise<boolean> {
    if (required.length === 0) return true;
    const held = await this.permissionsFor(roleKey);
    return required.every((permission) => held.has(permission));
  }

  async list(): Promise<readonly RoleView[]> {
    const rows = await this.prisma.role.findMany({
      include: { permissions: { select: { permission: true } } },
      orderBy: { key: 'asc' },
    });
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      description: row.description,
      isSystem: row.isSystem,
      permissions: row.permissions
        .map((grant) => grant.permission)
        .filter(isPermission)
        .sort(),
    }));
  }

  /**
   * Replaces what a role carries.
   *
   * Two rules, both refusals rather than warnings, both enforced here rather
   * than in the controller so that no future caller can reach the write without
   * them:
   *
   *   - an editor may not grant a capability they do not themselves hold;
   *   - no role may hold a combination `INCOMPATIBLE_PERMISSIONS` names.
   *
   * The whole replacement happens in one transaction with the audit record, so
   * a grant that was applied and not recorded is not a state this can reach.
   */
  async setPermissions(
    roleKey: string,
    requested: readonly string[],
    editor: { readonly id: string; readonly role: string },
  ): Promise<RoleView> {
    const unknown = requested.filter((value) => !isPermission(value));
    if (unknown.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Not capabilities this platform defines: ${unknown.join(', ')}`,
        { unknown: unknown.join(',') },
      );
    }
    const permissions = [...new Set(requested.filter(isPermission))].sort();

    const conflicts = conflictsIn(permissions);
    if (conflicts.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `A single role may not hold ${conflicts
          .map(([a, b]) => `${a} together with ${b}`)
          .join('; ')}. Crediting an account and trading the credit must be two people. ` +
          'Use two roles, or a master-account link that names the account.',
        { conflicts: conflicts.map(([a, b]) => `${a}+${b}`).join(',') },
      );
    }

    const editorHolds = await this.permissionsFor(editor.role);
    const escalations = escalationsIn(permissions, editorHolds);
    if (escalations.length > 0) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `You cannot grant a capability you do not hold yourself: ${escalations.join(', ')}`,
        { escalations: escalations.join(',') },
      );
    }

    const tenantId = requireTenantId();
    const role = await this.prisma.role.findFirst({
      where: { key: roleKey },
      include: { permissions: { select: { permission: true } } },
    });
    if (role === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such role');
    }
    const before = role.permissions.map((grant) => grant.permission).sort();

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({ tenantId, roleId: role.id, permission })),
      });
      await tx.role.update({ where: { id: role.id }, data: { updatedAt: new Date() } });
      /**
       * Inside the transaction, so a change that is not recorded is not a
       * change. Every other audit call in this codebase is fire-and-forget for
       * a good reason — losing the record of a fill beats losing the fill — but
       * a silent alteration of what a role may do is indistinguishable from an
       * intruder's, and there is no operation here worth keeping without it.
       */
      await this.audit.record(
        {
          actorId: editor.id,
          actorType: 'ADMIN',
          action: 'role.permissions.changed',
          resourceType: 'Role',
          resourceId: role.id,
          before: { key: roleKey, permissions: before },
          after: {
            key: roleKey,
            permissions: [...permissions],
            added: permissions.filter((p) => !before.includes(p)),
            removed: before.filter((p) => !permissions.includes(p as Permission)),
          },
        },
        tx,
      );
    });

    await this.invalidate(tenantId);

    return {
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions,
    };
  }

  /**
   * Puts a built-in role back to the set this build ships with.
   *
   * ## Why this is exempt from the escalation rule
   *
   * `setPermissions` refuses to grant a capability the editor does not hold, and
   * that rule would make this operation impossible where it is most needed: the
   * default `USER` role carries `orders.create`, which `ADMIN` deliberately does
   * not, so no administrator could ever restore it. The rule exists because an
   * editor chooses the set; here the set comes from the build. There is nothing
   * to escalate *to* — the request names a role, not a capability.
   *
   * The incompatibility rule still applies, and a shipped set that violated it
   * would fail here as loudly as anywhere else. `permissions.test.ts` asserts no
   * built-in role does.
   *
   * Only built-in roles. A role somebody created has no defaults to go back to,
   * and inventing an empty set and calling it "restored" would be a way to
   * silently disable a role while appearing to fix one.
   */
  async resetToDefaults(
    roleKey: string,
    editor: { readonly id: string; readonly role: string },
  ): Promise<RoleView> {
    const shipped = seedRoles().find((role) => role.key === roleKey);
    if (shipped === undefined) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${roleKey} is not a built-in role, so it has no defaults to restore`,
      );
    }

    const conflicts = conflictsIn(shipped.permissions);
    if (conflicts.length > 0) {
      // Unreachable while the unit test holds; loud rather than silent if it stops.
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `The built-in grants for ${roleKey} are themselves incompatible: ${conflicts
          .map(([a, b]) => `${a}+${b}`)
          .join(', ')}`,
      );
    }

    const tenantId = requireTenantId();
    const role = await this.prisma.role.findFirst({
      where: { key: roleKey },
      include: { permissions: { select: { permission: true } } },
    });
    if (role === null) throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such role');
    if (!role.isSystem) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${roleKey} was created here rather than shipped, so it has no defaults to restore`,
      );
    }

    const before = role.permissions.map((grant) => grant.permission).sort();
    const permissions = [...shipped.permissions].sort();

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({ tenantId, roleId: role.id, permission })),
      });
      await tx.role.update({ where: { id: role.id }, data: { updatedAt: new Date() } });
      await this.audit.record(
        {
          actorId: editor.id,
          actorType: 'ADMIN',
          action: 'role.permissions.reset',
          resourceType: 'Role',
          resourceId: role.id,
          before: { key: roleKey, permissions: before },
          after: { key: roleKey, permissions: [...permissions] },
        },
        tx,
      );
    });

    await this.invalidate(tenantId);
    return {
      key: role.key,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions,
    };
  }

  /**
   * Seeds a tenant's roles from the code constants.
   *
   * Called when a tenant is created, and idempotent so that calling it on an
   * existing tenant repairs a missing role rather than failing or duplicating.
   * It does **not** restore a capability somebody removed: only roles that are
   * absent entirely are written.
   */
  async seed(tenantId: string): Promise<void> {
    for (const role of seedRoles()) {
      const existing = await this.prisma.role.findFirst({ where: { key: role.key } });
      if (existing !== null) continue;
      await this.prisma.role.create({
        data: {
          tenantId,
          key: role.key,
          name: role.name,
          description: role.description,
          isSystem: true,
          permissions: {
            create: role.permissions.map((permission) => ({ tenantId, permission })),
          },
        },
      });
    }
    await this.invalidate(tenantId);
  }

  /** Drops this tenant's cached grants here and on every other instance. */
  async invalidate(tenantId: string): Promise<void> {
    this.markDirty(tenantId);
    try {
      await this.redis.publisher.publish(
        ROLE_INVALIDATION_CHANNEL,
        JSON.stringify({ tenantId, origin: INSTANCE_ID }),
      );
    } catch (error) {
      /**
       * A failed broadcast is not a failed write. The grant is already in the
       * database and this instance already dropped its copy; the others will be
       * wrong until they restart, which is worth an error line and not worth
       * refusing the change that already happened.
       */
      this.logger.error(
        `Role change saved but not broadcast; other instances may serve stale grants: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private markDirty(tenantId: string): void {
    const entry = this.cache.get(tenantId);
    if (entry !== undefined) entry.dirty = true;
  }

  private async resolve(tenantId: string): Promise<TenantRoles> {
    const cached = this.cache.get(tenantId);
    if (cached !== undefined && !cached.dirty) return cached;

    const existing = this.inFlight.get(tenantId);
    if (existing !== undefined) return existing;

    const load = this.load(tenantId, cached)
      .then((loaded) => {
        this.cache.set(tenantId, loaded);
        return loaded;
      })
      .finally(() => {
        this.inFlight.delete(tenantId);
      });
    this.inFlight.set(tenantId, load);
    return load;
  }

  private async load(tenantId: string, previous: TenantRoles | undefined): Promise<TenantRoles> {
    let rows;
    try {
      rows = await this.prisma.role.findMany({
        include: { permissions: { select: { permission: true } } },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (previous !== undefined) {
        this.logger.error(
          `Could not reload role grants for tenant ${tenantId}; serving the last known set: ${message}`,
        );
        return { byKey: previous.byKey, dirty: true };
      }
      this.logger.error(
        `Could not read role grants for tenant ${tenantId} and have never read them; ` +
          `falling back to the built-in grants, which is the behaviour before roles became data: ${message}`,
      );
      return { byKey: builtIn(), dirty: true };
    }

    if (rows.length === 0) {
      /**
       * Seeding never ran for this tenant. Denying everything would take the
       * whole firm offline over an infrastructure gap, so the built-in grants
       * stand in — the same set the migration would have written — and the log
       * says so at error level because the row is still missing.
       */
      this.logger.error(
        `Tenant ${tenantId} has no roles. Using the built-in grants; run the roles seed for it.`,
      );
      return { byKey: builtIn(), dirty: true };
    }

    const byKey = new Map<string, ReadonlySet<Permission>>();
    for (const row of rows) {
      byKey.set(row.key, new Set(row.permissions.map((g) => g.permission).filter(isPermission)));
    }
    return { byKey, dirty: false };
  }
}

/** The compile-time grants, shaped like a loaded tenant. The fallback, never the source. */
function builtIn(): ReadonlyMap<string, ReadonlySet<Permission>> {
  const byKey = new Map<string, ReadonlySet<Permission>>();
  for (const role of Object.values(UserRole)) byKey.set(role, new Set(codePermissionsFor(role)));
  return byKey;
}

/** Exported for the catalogue endpoint: everything a role could be granted. */
export const GRANTABLE_PERMISSIONS: readonly Permission[] = [...ALL_PERMISSIONS].sort();
