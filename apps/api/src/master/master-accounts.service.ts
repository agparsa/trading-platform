import { Injectable } from '@nestjs/common';
import {
  DomainError,
  isLinkableCapability,
  isMasterRole,
  LINKABLE_CAPABILITIES,
  MASTER_ROLE_CAPABILITIES,
  MasterRole,
  masterRoleOf,
  Permission,
  TradingErrorCode,
} from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { requireTenantId } from '@tp/tenancy';

export interface MasterAccountSummary {
  id: string;
  name: string;
  status: string;
  operatorUserId: string;
  activeLinks: number;
  createdAt: string;
}

export interface MasterLinkSummary {
  id: string;
  accountId: string;
  accountNumber: string;
  capabilities: string[];
  /** The preset it was granted as, when it was granted as one. */
  grantedAsRole: string | null;
  /**
   * The preset these capabilities amount to today, or null when they are
   * their own thing. Derived on read, so a link whose capabilities were later
   * edited one by one stops claiming to be the preset it started as.
   */
  role: string | null;
  status: string;
  grantedByUserId: string;
  grantedAt: string;
  revokedAt: string | null;
}

/**
 * Master accounts and the delegations they hold.
 *
 * The rule this service exists to enforce, and the one everything else here is
 * subordinate to: **a master account confers nothing by itself**. Creating one
 * grants no access. Operating one grants no access. Only a link does, only to
 * the account it names, and only for the capabilities it lists.
 *
 * Granting is the sharp edge, so it is deliberately narrow: the capabilities
 * must be inside the linkable ceiling, the account and master must both exist,
 * and every grant and revocation writes an audit row naming who did it. A
 * delegation nobody can trace is indistinguishable from an intrusion.
 */
@Injectable()
export class MasterAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    actorUserId: string,
    input: { operatorUserId: string; name: string },
  ): Promise<MasterAccountSummary> {
    const operator = await this.prisma.user.findUnique({
      where: { id: input.operatorUserId },
      select: { id: true },
    });
    if (operator === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'User not found', {
        userId: input.operatorUserId,
      });
    }

    const master = await this.prisma.masterAccount.create({
      data: { tenantId: requireTenantId(), userId: input.operatorUserId, name: input.name },
    });
    await this.audit.record({
      actorId: actorUserId,
      actorType: 'ADMIN',
      action: 'master_account.created',
      resourceType: 'MasterAccount',
      resourceId: master.id,
      after: { operatorUserId: input.operatorUserId, name: input.name },
    });
    return this.toSummary({ ...master, _count: { links: 0 } });
  }

  /**
   * Grants a delegation.
   *
   * Re-granting an existing link replaces its capabilities and reactivates it
   * rather than failing, because "give this operator read as well" is the
   * normal request and forcing a revoke-then-regrant would make the audit trail
   * harder to read, not easier. The update is audited with both states.
   */
  async grantLink(
    actorUserId: string,
    masterAccountId: string,
    input: { accountId: string; capabilities?: readonly string[]; role?: string },
  ): Promise<MasterLinkSummary> {
    const { capabilities, grantedAsRole } = this.resolveGrant(input);

    const master = await this.prisma.masterAccount.findUnique({
      where: { id: masterAccountId },
      select: { id: true, userId: true },
    });
    if (master === null) throw this.masterNotFound(masterAccountId);

    const account = await this.prisma.account.findUnique({
      where: { id: input.accountId },
      select: { id: true, userId: true },
    });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId: input.accountId,
      });
    }

    /**
     * An operator may not be delegated their own account. It would be a link
     * that grants nothing — ownership already reaches further — while making
     * the audit trail claim a delegation was needed where none was.
     */
    if (account.userId === master.userId) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This account already belongs to the operator of that master account',
        { accountId: input.accountId },
      );
    }

    const existing = await this.prisma.masterAccountLink.findUnique({
      where: { masterAccountId_accountId: { masterAccountId, accountId: input.accountId } },
    });

    const link = await this.prisma.masterAccountLink.upsert({
      where: { masterAccountId_accountId: { masterAccountId, accountId: input.accountId } },
      create: {
        tenantId: requireTenantId(),
        masterAccountId,
        accountId: input.accountId,
        capabilities: [...capabilities],
        grantedAsRole,
        grantedByUserId: actorUserId,
      },
      update: {
        capabilities: [...capabilities],
        grantedAsRole,
        status: 'ACTIVE',
        grantedByUserId: actorUserId,
        grantedAt: new Date(),
        revokedAt: null,
        revokedByUserId: null,
      },
      include: { account: { select: { number: true } } },
    });

    await this.audit.record({
      actorId: actorUserId,
      actorType: 'ADMIN',
      action: 'master_link.granted',
      resourceType: 'MasterAccountLink',
      resourceId: link.id,
      ...(existing === null
        ? {}
        : {
            before: {
              capabilities: existing.capabilities,
              grantedAsRole: existing.grantedAsRole,
              status: existing.status,
            },
          }),
      after: {
        masterAccountId,
        accountId: input.accountId,
        // Both: what was asked for, and what it became. A preset that widens
        // next quarter must not make this row read as though more was granted.
        grantedAsRole,
        capabilities: [...capabilities],
      },
    });

    return this.toLinkSummary(link, link.account.number);
  }

  /**
   * Revokes a delegation.
   *
   * The row stays, with a status and a timestamp. "Who could have closed that
   * position last March" must remain answerable after the answer has stopped
   * being true, and a deleted row answers nothing.
   */
  async revokeLink(
    actorUserId: string,
    masterAccountId: string,
    accountId: string,
  ): Promise<MasterLinkSummary> {
    const existing = await this.prisma.masterAccountLink.findUnique({
      where: { masterAccountId_accountId: { masterAccountId, accountId } },
      include: { account: { select: { number: true } } },
    });
    if (existing === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Link not found', {
        masterAccountId,
        accountId,
      });
    }
    if (existing.status === 'REVOKED') return this.toLinkSummary(existing, existing.account.number);

    const link = await this.prisma.masterAccountLink.update({
      where: { id: existing.id },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedByUserId: actorUserId },
      include: { account: { select: { number: true } } },
    });

    await this.audit.record({
      actorId: actorUserId,
      actorType: 'ADMIN',
      action: 'master_link.revoked',
      resourceType: 'MasterAccountLink',
      resourceId: link.id,
      before: { capabilities: existing.capabilities, status: existing.status },
      after: { status: link.status },
    });

    return this.toLinkSummary(link, link.account.number);
  }

  async list(): Promise<MasterAccountSummary[]> {
    const masters = await this.prisma.masterAccount.findMany({
      include: { _count: { select: { links: { where: { status: 'ACTIVE' } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return masters.map((master) => this.toSummary(master));
  }

  async links(masterAccountId: string): Promise<MasterLinkSummary[]> {
    const master = await this.prisma.masterAccount.findUnique({
      where: { id: masterAccountId },
      select: { id: true },
    });
    if (master === null) throw this.masterNotFound(masterAccountId);

    const links = await this.prisma.masterAccountLink.findMany({
      where: { masterAccountId },
      include: { account: { select: { number: true } } },
      orderBy: { grantedAt: 'desc' },
    });
    return links.map((link) => this.toLinkSummary(link, link.account.number));
  }

  /**
   * Refuses anything outside the ceiling, by name.
   *
   * A silent filter here would be worse than a refusal: the caller would be
   * told the grant succeeded and would believe the operator had a capability
   * they do not have, which is how an operator ends up unable to act in the one
   * moment it matters.
   */
  /**
   * What this grant amounts to: a preset expanded, or an explicit list.
   *
   * Exactly one of the two must be given. Accepting both would raise the
   * question of which wins on a disagreement, and every answer to that
   * question is a way for someone to think they granted a viewer and to have
   * granted a trader.
   */
  private resolveGrant(input: { capabilities?: readonly string[]; role?: string }): {
    capabilities: readonly Permission[];
    grantedAsRole: string | null;
  } {
    const hasRole = input.role !== undefined;
    const hasList = input.capabilities !== undefined;
    if (hasRole && hasList) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Give a role or a list of capabilities, not both: which one won would be a guess.',
      );
    }
    if (hasRole) {
      const role = input.role as string;
      if (!isMasterRole(role)) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `${role} is not a delegation role. The roles are: ${Object.keys(MASTER_ROLE_CAPABILITIES).join(', ')}`,
          { role },
        );
      }
      /**
       * Expanded here and stored, never re-read. The name is kept beside the
       * list so a screen can say "Trader" and an audit row can say what was
       * asked for — but widening the preset next quarter must not widen a
       * delegation that was approved under the old meaning.
       */
      return {
        capabilities: this.validateCapabilities(MASTER_ROLE_CAPABILITIES[role as MasterRole]),
        grantedAsRole: role,
      };
    }
    return {
      capabilities: this.validateCapabilities(input.capabilities ?? []),
      grantedAsRole: null,
    };
  }

  private validateCapabilities(requested: readonly string[]): readonly Permission[] {
    if (requested.length === 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A link with no capabilities grants nothing; revoke it instead',
      );
    }
    const rejected = requested.filter((value) => !isLinkableCapability(value));
    if (rejected.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `These cannot be delegated through a master link: ${rejected.join(', ')}. ` +
          `A link may carry: ${LINKABLE_CAPABILITIES.join(', ')}`,
        { rejected: rejected.join(',') },
      );
    }
    return [...new Set(requested.filter(isLinkableCapability))];
  }

  private masterNotFound(masterAccountId: string): DomainError {
    return new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Master account not found', {
      masterAccountId,
    });
  }

  private toSummary(master: {
    id: string;
    name: string;
    status: string;
    userId: string;
    createdAt: Date;
    _count: { links: number };
  }): MasterAccountSummary {
    return {
      id: master.id,
      name: master.name,
      status: master.status,
      operatorUserId: master.userId,
      activeLinks: master._count.links,
      createdAt: master.createdAt.toISOString(),
    };
  }

  private toLinkSummary(
    link: {
      id: string;
      accountId: string;
      capabilities: string[];
      grantedAsRole: string | null;
      status: string;
      grantedByUserId: string;
      grantedAt: Date;
      revokedAt: Date | null;
    },
    accountNumber: string,
  ): MasterLinkSummary {
    return {
      id: link.id,
      accountId: link.accountId,
      accountNumber,
      capabilities: link.capabilities,
      grantedAsRole: link.grantedAsRole,
      // Derived, not stored: a link whose capabilities were later edited one
      // by one must stop claiming to be the preset it was granted as.
      role: masterRoleOf(link.capabilities),
      status: link.status,
      grantedByUserId: link.grantedByUserId,
      grantedAt: link.grantedAt.toISOString(),
      revokedAt: link.revokedAt?.toISOString() ?? null,
    };
  }
}
