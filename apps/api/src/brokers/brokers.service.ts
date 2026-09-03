import { Injectable, Logger } from '@nestjs/common';
import type { PrismaClient, TenantStatus } from '@prisma/client';
import { DomainError, TradingErrorCode, UserRole, type ExecutionMode } from '@tp/shared-types';
import { currentTenant, seedTenantRoles, withTenant, type TenantContext } from '@tp/tenancy';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvitesService, type MintedInvite } from '../auth/invites.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';

/**
 * Brokers, as the platform sees them.
 *
 * A broker **is** a tenant. Creating one is creating a tenant, seeding the
 * roles a broker has, and minting the invitation its first owner registers
 * with. There is no separate broker table to drift from the tenant it
 * describes: the profile fields live on `Tenant` and the platform is the one
 * tenant whose kind says so.
 *
 * ## Only from the platform
 *
 * Every method first checks that the tenant in scope is the PLATFORM one. The
 * capability (`tenants.manage`) is only seeded on platform roles, so a broker's
 * administrator does not hold it — but a capability is a row somebody with
 * `roles.manage` can add, and "a broker that can create brokers" is not a state
 * a permissions edit should be able to reach. The kind of tenant is not a row
 * anybody edits.
 *
 * ## Crossing into the new tenant
 *
 * Seeding roles and minting the invitation happen *inside* the new tenant's
 * scope, so its rows carry its id and its RLS policy accepts them. The platform
 * actor's id goes on those rows as the creator — the user table is not what
 * scopes an invitation, and the broker's own audit log should say who set it
 * up. The platform's audit log gets the tenant-level record.
 */
@Injectable()
export class BrokersService {
  private readonly logger = new Logger(BrokersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invites: InvitesService,
    private readonly resolver: TenantResolver,
  ) {}

  async list(): Promise<readonly BrokerView[]> {
    this.assertPlatform();
    const rows = await this.prisma.tenant.findMany({
      where: { kind: 'BROKER' },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { users: true, accounts: true } } },
    });
    return rows.map(toView);
  }

  async get(id: string): Promise<BrokerView> {
    this.assertPlatform();
    const row = await this.prisma.tenant.findFirst({
      where: { id, kind: 'BROKER' },
      include: { _count: { select: { users: true, accounts: true } } },
    });
    if (row === null) throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such broker');
    return toView(row);
  }

  /**
   * Create a broker and hand back the one thing that cannot be fetched again:
   * the owner's invitation code.
   */
  async create(
    actor: { readonly id: string; readonly role: string },
    input: {
      readonly slug: string;
      readonly name: string;
      readonly legalName?: string | undefined;
      readonly primaryHost?: string | undefined;
      readonly defaultExecutionMode?: ExecutionMode | undefined;
      readonly ownerInviteTtlHours?: number | undefined;
    },
  ): Promise<BrokerCreated> {
    const platform = this.assertPlatform();

    const slug = input.slug.trim().toLowerCase();
    const primaryHost = input.primaryHost?.trim().toLowerCase() || null;

    const taken = await this.prisma.tenant.findFirst({
      where: { OR: [{ slug }, ...(primaryHost === null ? [] : [{ primaryHost }])] },
      select: { slug: true, primaryHost: true },
    });
    if (taken !== null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        taken.slug === slug
          ? `A tenant with the slug '${slug}' already exists.`
          : `The host '${primaryHost}' already belongs to '${taken.slug}'.`,
      );
    }

    const tenant = await this.prisma.tenant.create({
      data: {
        slug,
        name: input.name.trim(),
        legalName: input.legalName?.trim() || null,
        primaryHost,
        kind: 'BROKER',
        defaultExecutionMode: input.defaultExecutionMode ?? 'INTERNAL',
      },
    });

    const scope = { tenantId: tenant.id, slug: tenant.slug, kind: 'BROKER' as const };
    const { roles, invite } = await withTenant(scope, async () => {
      const seeded = await seedTenantRoles(
        this.prisma as unknown as PrismaClient,
        tenant.id,
        'BROKER',
      );
      /**
       * The invitation is minted in the broker's tenant, for its OWNER role, by
       * the platform actor. `mint` bounds a role-granting invitation by the
       * minter's own role — looked up in the tenant in scope, which is the
       * broker's, where a platform role has no row and would hold nothing.
       * That bound does not apply here: the authority to appoint a firm's
       * first owner *is* `tenants.manage`, checked at the door of this method,
       * and a broker with no owner is a broker nobody can run. So the mint is
       * told the minter is the owner-equivalent, and the platform's own audit
       * record below names who really did it.
       */
      const minted = await this.invites.mint(
        { id: actor.id, role: UserRole.BROKER_OWNER },
        {
          label: `Owner of ${tenant.name}`,
          maxUses: 1,
          ttlHours: input.ownerInviteTtlHours ?? 72,
          grantsRole: UserRole.BROKER_OWNER,
        },
      );
      return { roles: seeded, invite: minted };
    });

    this.resolver.forget();

    await withTenant(platform, () =>
      this.audit.record({
        actorId: actor.id,
        actorType: 'ADMIN',
        action: 'tenant.created',
        resourceType: 'tenant',
        resourceId: tenant.id,
        after: {
          slug: tenant.slug,
          name: tenant.name,
          legalName: tenant.legalName,
          primaryHost: tenant.primaryHost,
          kind: tenant.kind,
          defaultExecutionMode: tenant.defaultExecutionMode,
          rolesSeeded: roles.created,
          ownerInviteFingerprint: invite.fingerprint,
        },
      }),
    );

    this.logger.log({ slug: tenant.slug, rolesSeeded: roles.created }, 'Broker created');

    return {
      broker: toView({ ...tenant, _count: { users: 0, accounts: 0 } }),
      ownerInvite: invite,
    };
  }

  /** Suspend, reinstate or close a broker. A closed one does not come back. */
  async setStatus(
    actor: { readonly id: string },
    id: string,
    status: TenantStatus,
    reason: string,
  ): Promise<BrokerView> {
    this.assertPlatform();
    const before = await this.prisma.tenant.findFirst({ where: { id, kind: 'BROKER' } });
    if (before === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such broker');
    }
    if (before.status === 'CLOSED') {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, 'A closed broker stays closed.');
    }
    if (before.status === status) return this.get(id);

    const after = await this.prisma.tenant.update({
      where: { id },
      data: { status },
      include: { _count: { select: { users: true, accounts: true } } },
    });
    this.resolver.forget();

    await this.audit.record({
      actorId: actor.id,
      actorType: 'ADMIN',
      action: 'tenant.status_changed',
      resourceType: 'tenant',
      resourceId: id,
      before: { status: before.status },
      after: { status, reason },
    });
    return toView(after);
  }

  private assertPlatform(): TenantContext {
    const tenant = currentTenant();
    if (tenant === undefined || tenant.kind !== 'PLATFORM') {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'Brokers are managed from the platform, not from a broker.',
      );
    }
    return tenant;
  }
}

export interface BrokerView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly primaryHost: string | null;
  readonly status: TenantStatus;
  readonly defaultExecutionMode: ExecutionMode;
  readonly users: number;
  readonly accounts: number;
  readonly createdAt: Date;
}

export interface BrokerCreated {
  readonly broker: BrokerView;
  /** Shown once. The platform keeps its hash and fingerprint, nothing more. */
  readonly ownerInvite: MintedInvite;
}

function toView(row: {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  primaryHost: string | null;
  status: TenantStatus;
  defaultExecutionMode: ExecutionMode;
  createdAt: Date;
  _count: { users: number; accounts: number };
}): BrokerView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    legalName: row.legalName,
    primaryHost: row.primaryHost,
    status: row.status,
    defaultExecutionMode: row.defaultExecutionMode,
    users: row._count.users,
    accounts: row._count.accounts,
    createdAt: row.createdAt,
  };
}
