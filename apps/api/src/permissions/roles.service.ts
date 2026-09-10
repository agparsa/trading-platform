import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  DomainError,
  type Permission,
  ROLE_GROUP,
  TradingErrorCode,
  UserRole,
  conflictsIn,
  escalationsIn,
  groupOutranks,
  isPermission,
  permissionsFor as codePermissionsFor,
  seedRoles,
} from '@tp/shared-types';
import { requireTenantId, seedTenantRoles, withoutTenantScope } from '@tp/tenancy';
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

    await this.reconcileWithBuild();
  }

  /**
   * Brings every tenant's untouched built-in roles in line with this build.
   *
   * ## Why this has to happen at boot
   *
   * Grants became rows so a firm could change what a role carries without a
   * deployment. That made the reverse case a problem nobody had before: a
   * release that adds a capability writes it into a constant, and the constant
   * is not what the guard reads. `seedTenantRoles` knows how to close that gap
   * and, until now, only the database seed ever called it — so a deployed
   * platform that upgraded through `prisma migrate deploy` got the new
   * endpoints and none of the permission to reach them. Every one of them
   * answered 403, in production, having passed every test.
   *
   * That is not hypothetical either. It is exactly what the payments phase's own
   * smoke check hit: `GET /payments/providers` refused a freshly registered
   * trader, because `payments.read` existed in the constant and in no row.
   *
   * ## Why it is safe to run on every replica, every boot
   *
   * It is idempotent — a role already matching the build is skipped without a
   * write — and it will not touch a role anybody has edited, which is what
   * `grantsEditedAt` is for. Two replicas booting together can race on creating
   * a role for a brand-new tenant; that surfaces as a unique violation on one of
   * them, which is logged and not fatal. An API that cannot reconcile roles must
   * still start and still enforce the roles it can read.
   *
   * ## Why it runs through the privileged pool, not a pool per tenant
   *
   * It used to enter each tenant's scope in turn, which is the natural way to
   * write it and the wrong way to run it. A connection is bound to one tenant
   * for its life, so entering thirty-five scopes in a second opens thirty-five
   * pools — and `DATABASE_TENANT_POOLS` did not stop it, because an evicted
   * pool keeps its connections for a drain period so that work already on it
   * can finish. Two instances booting against a development database the
   * penetration suite had filled with tenants asked a stock Postgres for more
   * connections than it had; this very sweep failed for some tenants, the
   * price-alert sweep failed, and a trader registering was told
   * `INTERNAL_ERROR`. The load harness found it.
   *
   * This is platform work — a release reaching every tenant — which is exactly
   * what `withoutTenantScope` exists to name. `seedTenantRoles` states the
   * tenant on every row it reads or writes, so nothing depends on the scope to
   * narrow or stamp; the sweep runs on the owner's single pool, and boot opens
   * no tenant pool at all until the first request needs one.
   */
  private async reconcileWithBuild(): Promise<void> {
    await withoutTenantScope(
      'a release adds capabilities to every tenant, not to one; reconciling through one pool keeps boot from opening a pool per tenant',
      async () => {
        let tenants;
        try {
          tenants = await this.prisma.tenant.findMany({
            select: { id: true, slug: true, kind: true },
          });
        } catch (error) {
          this.logger.error(
            'Could not read the tenant list to reconcile roles. Roles are whatever the database holds.',
            error instanceof Error ? error.stack : String(error),
          );
          return;
        }

        let created = 0;
        let refreshed = 0;
        for (const tenant of tenants) {
          try {
            const result = await seedTenantRoles(
              this.prisma as unknown as PrismaClient,
              tenant.id,
              tenant.kind,
            );
            created += result.created;
            refreshed += result.refreshed;
            if (result.created > 0 || result.refreshed > 0) this.markDirty(tenant.id);
          } catch (error) {
            this.logger.warn(
              `Could not reconcile roles for ${tenant.slug}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        this.reportReconciliation(created, refreshed, tenants.length);
      },
    );
  }

  private reportReconciliation(created: number, refreshed: number, tenantCount: number): void {
    if (created > 0 || refreshed > 0) {
      /**
       * Said out loud, because it is a change to what people may do.
       *
       * An operator reading a log after an upgrade should be able to see that a
       * role gained a capability, rather than discovering it from a screen
       * somebody could suddenly reach.
       */
      this.logger.log(
        `Roles reconciled with this build: ${created} created, ${refreshed} brought up to date ` +
          `across ${tenantCount} tenant(s). Roles that had been edited were left alone.`,
      );
    }
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

  /**
   * May somebody in `assignerRole` put a person into `role`?
   *
   * Three refusals, in order of how often they should fire:
   *
   * 1. **Not a role this tenant has.** The enum lists every role any tenant
   *    could seed; a broker does not seed the platform's. `PLATFORM_SUPER_ADMIN`
   *    on a broker's user would be a role with no grants — harmless today, a
   *    live account waiting for the day somebody seeds it.
   * 2. **Above the assigner's group.** A broker administrator appoints broker
   *    staff and traders; only platform staff appoint platform staff. This is
   *    decided by group rather than by comparing grants, because the built-in
   *    roles are deliberately *not* nested: an administrator cannot pay a
   *    withdrawal and finance cannot assign a role, and the separation is the
   *    point. Comparing grants would leave nobody able to appoint the finance
   *    desk at all.
   * 3. **Grants the assigner lacks, when somebody edited them.** A built-in
   *    role with its shipped grants is a reviewed design, and appointing to it
   *    is what `roles.assign` is for. A role somebody has widened is that
   *    person's design, and here the bound that stops an editor widening their
   *    own role applies: you cannot hand out what you do not hold.
   */
  async assertAssignable(role: UserRole, assignerRole: string): Promise<void> {
    const row = await this.prisma.role.findFirst({
      where: { key: role },
      select: { id: true, isSystem: true, grantsEditedAt: true },
    });
    if (row === null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${role} is not a role this firm has.`,
        { role },
      );
    }

    const assignerGroup = isUserRole(assignerRole) ? ROLE_GROUP[assignerRole] : undefined;
    if (assignerGroup === undefined || !groupOutranks(assignerGroup, ROLE_GROUP[role])) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `${role} is appointed by ${ROLE_GROUP[role].toLowerCase()} staff, not from ${assignerRole}.`,
        { role, assignerRole },
      );
    }

    if (row.isSystem && row.grantsEditedAt === null) return;

    const [granted, held] = await Promise.all([
      this.permissionsFor(role),
      this.permissionsFor(assignerRole),
    ]);
    const escalations = escalationsIn(granted, held);
    if (escalations.length > 0) {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `${role} has been edited to hold capabilities you do not: ${escalations.join(', ')}`,
        { escalations: escalations.join(',') },
      );
    }
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
      /**
       * Stamped so the seed can tell an edited role from an untouched one.
       *
       * A release that adds a capability brings the untouched ones in line with
       * the build and leaves this one exactly as the operator left it. A deploy
       * that silently re-widened a role somebody had narrowed would be the worst
       * kind of regression, because nothing about it would look wrong.
       */
      await tx.role.update({
        where: { id: role.id },
        data: { updatedAt: new Date(), grantsEditedAt: new Date() },
      });
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
      // Cleared: the role is the build's again, so a future release that adds a
      // capability may top it up. See `prisma/roles.ts`.
      await tx.role.update({
        where: { id: role.id },
        data: { updatedAt: new Date(), grantsEditedAt: null },
      });
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

function isUserRole(value: string): value is UserRole {
  return (Object.values(UserRole) as string[]).includes(value);
}
