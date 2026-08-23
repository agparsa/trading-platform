import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AccountRiskLimits, RiskContext } from '@tp/risk-core';
import { PrismaService } from '../prisma/prisma.service';
import type { AccountValuation } from './account-state.service';

/**
 * Turns a live account valuation plus its configured limits into the context a
 * risk rule sees.
 *
 * A limit that is not configured is passed as `undefined`, which the rules read
 * as "not enforced". No default is invented here — a limit the operator never
 * set must not quietly start rejecting orders.
 */
@Injectable()
export class RiskContextBuilder {
  constructor(private readonly prisma: PrismaService) {}

  async build(
    valuation: AccountValuation,
    nowMs: number,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
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

    return {
      accountId: valuation.accountId,
      accountCurrency: valuation.currency,
      accountLeverage: valuation.leverage,
      equity: valuation.state.equity,
      freeMargin: valuation.state.freeMargin,
      usedMargin: valuation.state.usedMargin,
      exposureBySymbol: valuation.exposureBySymbol,
      openPositionCount: valuation.openPositionCount,
      limits,
      now: nowMs,
    };
  }
}
