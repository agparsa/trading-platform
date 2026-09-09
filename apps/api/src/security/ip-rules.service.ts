import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import {
  evaluate,
  isValidCidr,
  wouldLockOut,
  type IpDecision,
  type IpRule,
  type IpRuleKind,
  type IpRuleScope,
} from './ip-rules';
import type { Env } from '../config/env.schema';

/**
 * A firm's rules about where its people may reach it from (§46).
 *
 * ## Everything here exists to avoid one failure
 *
 * An allow-list that excludes the person who wrote it locks the firm out of the
 * screen where the mistake could be undone. The only remaining fix is a
 * database console, which is not a support process — it is an outage, at a firm
 * that was trying to improve its security.
 *
 * So:
 *
 * 1. A rule that would shut out its own author is **refused**, evaluated
 *    against the whole set as it would be after the write.
 * 2. Rules are refused entirely until the deployment has said what sits in
 *    front of it (`TRUSTED_PROXY_HOPS`, `0` included), because a rule enforced
 *    against a proxy's address admits everybody or excludes everybody.
 * 3. Disabling and deleting are never refused. Whatever state a firm has
 *    reached, the way *out* is always open.
 */
@Injectable()
export class IpRulesService {
  private readonly logger = new Logger(IpRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  /**
   * Whether this deployment has said what sits in front of it.
   *
   * Not "is it behind a proxy" — a deployment that has declared zero proxies
   * can see its clients perfectly well. It is "has an operator stated the
   * shape of the network", because until one has, every address this platform
   * sees might be an nginx container's.
   */
  enforceable(): boolean {
    return this.config.get('TRUSTED_PROXY_HOPS', { infer: true }) !== undefined;
  }

  async list() {
    return this.prisma.tenantIpRule.findMany({
      orderBy: [{ scope: 'asc' }, { kind: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        cidr: true,
        kind: true,
        scope: true,
        note: true,
        enabled: true,
        createdAt: true,
        createdBy: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  /** The enabled rules, as the guard needs them. */
  async active(): Promise<readonly IpRule[]> {
    const rows = await this.prisma.tenantIpRule.findMany({
      where: { enabled: true },
      select: { cidr: true, kind: true, scope: true },
    });
    return rows.map((row) => ({
      cidr: row.cidr,
      kind: row.kind as IpRuleKind,
      scope: row.scope as IpRuleScope,
    }));
  }

  async decide(address: string, scope: IpRuleScope): Promise<IpDecision> {
    return evaluate(address, await this.active(), scope);
  }

  async create(args: {
    readonly actorId: string;
    readonly actorAddress: string;
    readonly actorAddressTrusted: boolean;
    readonly cidr: string;
    readonly kind: IpRuleKind;
    readonly scope: IpRuleScope;
    readonly note: string;
  }) {
    if (!this.enforceable()) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'This deployment has not said how many proxies sit in front of it, so an IP rule could be enforced against a proxy rather than a client — set TRUSTED_PROXY_HOPS first (0 if nothing is in front of it)',
      );
    }
    if (!args.actorAddressTrusted) {
      /**
       * Refusing here rather than warning. The lock-out check below is only
       * meaningful if this platform knows the author's real address; running it
       * against a proxy's would clear a rule that shuts the author out.
       */
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'Your own address cannot be determined, so this rule cannot be checked against it',
      );
    }
    if (!isValidCidr(args.cidr)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `'${args.cidr}' is not an address or a range`,
      );
    }
    if (args.note.trim().length === 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'An IP rule needs a note — a rule nobody can explain a year later is a rule nobody dares remove',
      );
    }

    /**
     * Checked against the set **as it would be**, not against the new rule
     * alone. A single `ALLOW` that happens to contain the author is still a
     * lock-out if an existing `DENY` covers them, and a rule that looks
     * harmless on its own is exactly the one somebody adds without thinking.
     */
    const after: IpRule[] = [
      ...(await this.active()),
      { cidr: args.cidr, kind: args.kind, scope: args.scope },
    ];
    if (wouldLockOut(args.actorAddress, after, 'STAFF')) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `That rule would shut you out from ${args.actorAddress}. Add a rule covering your own address first.`,
        { yourAddress: args.actorAddress },
      );
    }

    const rule = await this.prisma.tenantIpRule.create({
      data: {
        tenantId: requireTenantId(),
        cidr: args.cidr.trim(),
        kind: args.kind,
        scope: args.scope,
        note: args.note.trim(),
        createdByUserId: args.actorId,
      },
      select: { id: true, cidr: true, kind: true, scope: true, enabled: true },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: 'IP_RULE_CREATED',
      resourceType: 'TenantIpRule',
      resourceId: rule.id,
      after: { cidr: rule.cidr, kind: rule.kind, scope: rule.scope, note: args.note.trim() },
    });

    this.logger.warn(
      { ruleId: rule.id, cidr: rule.cidr, kind: rule.kind, scope: rule.scope },
      'IP rule created',
    );
    return rule;
  }

  /**
   * Turn a rule off, or on.
   *
   * Turning **off** is never refused, whatever it does to the set. The way out
   * of a bad configuration has to stay open even when the configuration is the
   * problem — especially then.
   *
   * Turning **on** is checked like a creation, because it has the same effect.
   */
  async setEnabled(args: {
    readonly actorId: string;
    readonly actorAddress: string;
    readonly actorAddressTrusted: boolean;
    readonly id: string;
    readonly enabled: boolean;
  }) {
    const rule = await this.prisma.tenantIpRule.findUnique({
      where: { id: args.id },
      select: { id: true, cidr: true, kind: true, scope: true, enabled: true },
    });
    if (rule === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such rule');
    }

    if (args.enabled && rule.enabled === false) {
      if (!args.actorAddressTrusted) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          'Your own address cannot be determined, so this rule cannot be checked against it',
        );
      }
      const after: IpRule[] = [
        ...(await this.active()),
        {
          cidr: rule.cidr,
          kind: rule.kind as IpRuleKind,
          scope: rule.scope as IpRuleScope,
        },
      ];
      if (wouldLockOut(args.actorAddress, after, 'STAFF')) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `Enabling that rule would shut you out from ${args.actorAddress}.`,
          { yourAddress: args.actorAddress },
        );
      }
    }

    await this.prisma.tenantIpRule.update({
      where: { id: args.id },
      data: { enabled: args.enabled },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: args.actorId,
      action: args.enabled ? 'IP_RULE_ENABLED' : 'IP_RULE_DISABLED',
      resourceType: 'TenantIpRule',
      resourceId: args.id,
      after: { cidr: rule.cidr, kind: rule.kind, scope: rule.scope },
    });
    return { id: args.id, enabled: args.enabled };
  }

  /** Delete one. Never refused, for the same reason disabling never is. */
  async remove(actorId: string, id: string): Promise<void> {
    const { count } = await this.prisma.tenantIpRule.deleteMany({ where: { id } });
    if (count === 0) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such rule');
    }
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'IP_RULE_DELETED',
      resourceType: 'TenantIpRule',
      resourceId: id,
    });
  }
}
