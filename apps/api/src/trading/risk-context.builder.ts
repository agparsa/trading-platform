import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AccountRiskLimits, RiskContext } from '@tp/risk-core';
import { PrismaService } from '../prisma/prisma.service';
import { RiskLimitsService } from './risk-limits.service';
import type { AccountValuation } from './account-state.service';
import { requireTenantId } from '@tp/tenancy';

/**
 * Turns a live account valuation plus its configured limits into the context a
 * risk rule sees.
 *
 * A limit that is not configured is passed as `undefined`, which the rules read
 * as "not enforced". No default is invented here — a limit the operator never
 * set must not quietly start rejecting orders.
 *
 * ## The account's own settings are the floor of the hierarchy, not all of it
 *
 * Above the account sit the desk, the broker and the platform, each able to
 * tighten what the account is configured for and none able to loosen it
 * (`RiskLimitsService`). Resolving them here rather than at each call site is
 * deliberate: every path that risk-checks an order builds its context through
 * this method — market orders, pending fills, the trigger engine — so none of
 * them can be the one that forgets to apply a broker's ceiling.
 *
 * `masterAccountId` is the desk an order arrived through, when it did. The
 * engine's own paths pass null, and so does an owner trading their own
 * account: a ceiling a broker places on a desk binds that desk's operators,
 * not the account holder, who never agreed to it.
 */
@Injectable()
export class RiskContextBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly riskLimits: RiskLimitsService,
  ) {}

  async build(
    valuation: AccountValuation,
    nowMs: number,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
    masterAccountId: string | null = null,
  ): Promise<RiskContext> {
    const settings = await client.accountSettings.findUnique({
      where: { accountId: valuation.accountId },
    });

    const limits: AccountRiskLimits = {
      ...(settings?.maxPositionVolume == null
        ? {}
        : { maxPositionVolume: settings.maxPositionVolume.toString() }),
      ...(settings?.maxOpenPositions == null
        ? {}
        : { maxOpenPositions: settings.maxOpenPositions }),
      ...(settings?.maxGrossNotional == null
        ? {}
        : { maxGrossNotional: settings.maxGrossNotional.toString() }),
      ...(settings?.maxSymbolNetVolume == null
        ? {}
        : { maxSymbolNetVolume: settings.maxSymbolNetVolume.toString() }),
      ...(settings?.marginCallLevelPercent == null
        ? {}
        : { marginCallLevelPercent: settings.marginCallLevelPercent.toString() }),
      ...(settings?.stopOutLevelPercent == null
        ? {}
        : { stopOutLevelPercent: settings.stopOutLevelPercent.toString() }),
    };

    /**
     * The account's configured limits, tightened by every layer above it. The
     * stop-out and margin-call levels pass straight through: they are not caps
     * and "stricter" runs the other way for them, so folding them into a
     * minimum would make every account's stop-out the loosest on the platform.
     */
    const effective = await this.riskLimits.effective(
      { tenantId: requireTenantId(), accountLimits: limits, masterAccountId },
      client,
    );

    return {
      accountId: valuation.accountId,
      accountCurrency: valuation.currency,
      accountLeverage: valuation.leverage,
      equity: valuation.state.equity,
      freeMargin: valuation.state.freeMargin,
      usedMargin: valuation.state.usedMargin,
      exposureBySymbol: valuation.exposureBySymbol,
      openPositionCount: valuation.openPositionCount,
      limits: {
        ...effective.limits,
        ...(limits.marginCallLevelPercent === undefined
          ? {}
          : { marginCallLevelPercent: limits.marginCallLevelPercent }),
        ...(limits.stopOutLevelPercent === undefined
          ? {}
          : { stopOutLevelPercent: limits.stopOutLevelPercent }),
      },
      now: nowMs,
    };
  }
}
