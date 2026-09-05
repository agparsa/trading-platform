import { Injectable, Logger } from '@nestjs/common';
import type { RiskLimitLevel } from '@prisma/client';
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId, withoutTenantScope } from '@tp/tenancy';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { fromRow, isTighter } from '../trading/risk-limits.service';

/** The caps a layer may set. Stop-out levels are account-only — see `RiskLimitsService`. */
export const HIERARCHY_FIELDS = [
  'maxPositionVolume',
  'maxOpenPositions',
  'maxGrossNotional',
  'maxSymbolNetVolume',
] as const;
export type HierarchyField = (typeof HIERARCHY_FIELDS)[number];

export type LimitInput = Partial<Record<HierarchyField, string | number | null>>;

export interface LimitSetView {
  readonly level: RiskLimitLevel;
  readonly masterAccountId: string | null;
  readonly maxPositionVolume: string | null;
  readonly maxOpenPositions: number | null;
  readonly maxGrossNotional: string | null;
  readonly maxSymbolNetVolume: string | null;
  readonly updatedByUserId: string | null;
  readonly updatedAt: string | null;
}

/**
 * Setting the ceilings above an account.
 *
 * ## The rule, and where it is enforced
 *
 * A layer may tighten what the layer above allows. It may never loosen it. A
 * broker whose platform caps positions at 50 lots cannot set 100 — the attempt
 * is **refused, naming the layer that stops it**, rather than accepted and
 * quietly ignored. Refusing is the important half: an operator who is told
 * their 100-lot ceiling was saved will believe their traders can trade 100
 * lots, and will find out otherwise from a rejected order at the worst
 * possible moment.
 *
 * The resolver takes the tightest value across every layer anyway, so a row
 * that reaches this table some other way still cannot widen anything. That is
 * belt and braces on purpose: this service is where a person is *told*, and
 * the resolver is where the platform is *safe*.
 *
 * ## Who may set what
 *
 * The platform layer belongs to the platform and nobody else. A broker setting
 * a ceiling on itself, or on one of its desks, is an ordinary risk-management
 * act inside its own firm. So the platform layer additionally requires the
 * caller to be standing in the platform tenant — a broker with `risk.manage`
 * has it over its own firm, not over everyone's.
 */
@Injectable()
export class RiskHierarchyService {
  private readonly logger = new Logger(RiskHierarchyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every layer this firm can see, platform first. */
  async list(): Promise<readonly LimitSetView[]> {
    const platform = await this.platformRow();
    const own = await this.prisma.riskLimitSet.findMany({
      orderBy: [{ level: 'asc' }, { updatedAt: 'desc' }],
    });
    const rows = [
      ...(platform === null ? [] : [platform]),
      ...own.filter((row) => row.level !== 'PLATFORM'),
    ];
    return rows.map(toView);
  }

  async setBroker(actorId: string, limits: LimitInput): Promise<LimitSetView> {
    return this.set(actorId, { level: 'BROKER', masterAccountId: null }, limits);
  }

  async setDesk(
    actorId: string,
    masterAccountId: string,
    limits: LimitInput,
  ): Promise<LimitSetView> {
    const master = await this.prisma.masterAccount.findFirst({
      where: { id: masterAccountId },
      select: { id: true },
    });
    if (master === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such master account', {
        masterAccountId,
      });
    }
    return this.set(actorId, { level: 'DESK', masterAccountId }, limits);
  }

  /**
   * The platform's own ceiling.
   *
   * Only from inside the platform tenant. A broker holding `risk.manage` holds
   * it over its own firm; letting that reach this row would let one firm set
   * the ceiling every other firm trades under.
   */
  async setPlatform(actorId: string, limits: LimitInput): Promise<LimitSetView> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: requireTenantId() },
      select: { kind: true },
    });
    if (tenant?.kind !== 'PLATFORM') {
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        'The platform ceiling is set from the platform, not from a broker. ' +
          'A firm sets its own ceiling with the broker layer.',
      );
    }
    return this.set(actorId, { level: 'PLATFORM', masterAccountId: null }, limits);
  }

  /**
   * Refuses a set of limits that would be looser than the layers above.
   *
   * Exposed for the account layer, which lives on `AccountSettings` rather
   * than in this table but is bound by exactly the same rule. Sharing this
   * method is what keeps the two from drifting into different answers about
   * what "stricter" means.
   */
  async assertWithinCeiling(limits: LimitInput): Promise<void> {
    // Everything above an account: platform and broker. A desk ceiling is not
    // consulted, because it binds the desk's operators rather than the account
    // holder, who may legitimately be configured looser than an operator is.
    await this.refuseLooser(await this.ceilingAbove('DESK'), limits, 'this account');
  }

  private refuseLooser(
    ceiling: Partial<Record<HierarchyField, { value: string | number; layer: string }>>,
    limits: LimitInput,
    subject: string,
  ): void {
    for (const field of HIERARCHY_FIELDS) {
      const value = limits[field];
      if (value === undefined || value === null) continue;
      const above = ceiling[field];
      if (above === undefined) continue;
      // Equal is fine — restating the layer above is not loosening it.
      if (isTighter(field, above.value, value)) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `${field} cannot be ${String(value)} on ${subject}: the ${above.layer.toLowerCase()} ` +
            `layer above allows ${String(above.value)}, and a layer may only tighten what the ` +
            'one above it permits. Ask for the layer above to be raised, or set a lower value.',
          { field, requested: String(value), ceiling: String(above.value), layer: above.layer },
        );
      }
    }
  }

  private async set(
    actorId: string,
    where: { level: RiskLimitLevel; masterAccountId: string | null },
    limits: LimitInput,
  ): Promise<LimitSetView> {
    this.refuseLooser(
      await this.ceilingAbove(where.level),
      limits,
      `the ${where.level.toLowerCase()} layer`,
    );

    const existing = await this.prisma.riskLimitSet.findFirst({
      where:
        where.level === 'DESK'
          ? { masterAccountId: where.masterAccountId }
          : { level: where.level, masterAccountId: null },
    });

    const data = {
      ...(limits.maxPositionVolume === undefined
        ? {}
        : { maxPositionVolume: limits.maxPositionVolume as string | null }),
      ...(limits.maxOpenPositions === undefined
        ? {}
        : { maxOpenPositions: limits.maxOpenPositions as number | null }),
      ...(limits.maxGrossNotional === undefined
        ? {}
        : { maxGrossNotional: limits.maxGrossNotional as string | null }),
      ...(limits.maxSymbolNetVolume === undefined
        ? {}
        : { maxSymbolNetVolume: limits.maxSymbolNetVolume as string | null }),
      updatedByUserId: actorId,
    };

    const saved =
      existing === null
        ? await this.prisma.riskLimitSet.create({
            data: {
              tenantId: requireTenantId(),
              level: where.level,
              masterAccountId: where.masterAccountId,
              ...data,
            },
          })
        : await this.prisma.riskLimitSet.update({ where: { id: existing.id }, data });

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: 'risk_limits.set',
      resourceType: 'RiskLimitSet',
      resourceId: saved.id,
      ...(existing === null ? {} : { before: toAudit(existing) }),
      after: { level: where.level, masterAccountId: where.masterAccountId, ...toAudit(saved) },
    });
    this.logger.log(
      { level: where.level, masterAccountId: where.masterAccountId, actorId },
      'A risk ceiling was changed',
    );
    return toView(saved);
  }

  /**
   * The tightest value each field already has above this layer.
   *
   * `PLATFORM` has nothing above it. `BROKER` is bound by the platform.
   * `DESK` is bound by both. The account layer is not consulted: an account
   * may be tighter than its desk and that is not a conflict.
   */
  private async ceilingAbove(
    level: RiskLimitLevel,
  ): Promise<Partial<Record<HierarchyField, { value: string | number; layer: string }>>> {
    const above: Partial<Record<HierarchyField, { value: string | number; layer: string }>> = {};
    if (level === 'PLATFORM') return above;

    const layers: { layer: string; set: Partial<Record<HierarchyField, string | number>> }[] = [];
    const platform = await this.platformRow();
    layers.push({ layer: 'PLATFORM', set: fromRow(platform ?? undefined) });
    if (level === 'DESK') {
      const broker = await this.prisma.riskLimitSet.findFirst({
        where: { level: 'BROKER', masterAccountId: null },
      });
      layers.push({ layer: 'BROKER', set: fromRow(broker ?? undefined) });
    }

    for (const field of HIERARCHY_FIELDS) {
      for (const { layer, set } of layers) {
        const value = set[field];
        if (value === undefined) continue;
        const current = above[field];
        if (current === undefined || isTighter(field, value, current.value)) {
          above[field] = { value, layer };
        }
      }
    }
    return above;
  }

  private platformRow() {
    return withoutTenantScope(
      'every firm is bound by the platform ceiling, which lives in the platform tenant',
      async () => {
        const platform = await this.prisma.tenant.findFirst({
          where: { kind: 'PLATFORM' },
          select: { id: true },
        });
        if (platform === null) return null;
        return this.prisma.riskLimitSet.findFirst({
          where: { level: 'PLATFORM', tenantId: platform.id, masterAccountId: null },
        });
      },
    );
  }
}

/** The permission every one of these routes needs. Named once. */
export const RISK_HIERARCHY_PERMISSION = Permission.RISK_MANAGE;

interface Row {
  level: RiskLimitLevel;
  masterAccountId: string | null;
  maxPositionVolume: { toString(): string } | null;
  maxOpenPositions: number | null;
  maxGrossNotional: { toString(): string } | null;
  maxSymbolNetVolume: { toString(): string } | null;
  updatedByUserId: string | null;
  updatedAt: Date;
}

function toView(row: Row): LimitSetView {
  return {
    level: row.level,
    masterAccountId: row.masterAccountId,
    maxPositionVolume: row.maxPositionVolume?.toString() ?? null,
    maxOpenPositions: row.maxOpenPositions,
    maxGrossNotional: row.maxGrossNotional?.toString() ?? null,
    maxSymbolNetVolume: row.maxSymbolNetVolume?.toString() ?? null,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAudit(row: Row): Record<string, string | number | null> {
  return {
    maxPositionVolume: row.maxPositionVolume?.toString() ?? null,
    maxOpenPositions: row.maxOpenPositions,
    maxGrossNotional: row.maxGrossNotional?.toString() ?? null,
    maxSymbolNetVolume: row.maxSymbolNetVolume?.toString() ?? null,
  };
}
