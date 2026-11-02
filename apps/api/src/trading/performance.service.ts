import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
import type { CurrencyCode } from '@tp/financial-core';
import { performanceOf, type Performance } from '@tp/trading-core';
import type { Env } from '../config/env.schema';
import { AccountAccessService } from '../accounts/account-access.service';
import { PrismaService } from '../prisma/prisma.service';

export const PERFORMANCE_PERIODS = ['3M', '1Y', 'ALL'] as const;
export type PerformancePeriod = (typeof PERFORMANCE_PERIODS)[number];

/** More closed trades than this in one period are refused, not summarised in part. */
export const PERFORMANCE_TRADE_LIMIT = 100_000;

/**
 * The Analytics page's figures: `performanceOf` over the account's closed
 * trades in a period, with the balance the period started from.
 *
 * The starting balance is the ledger's — the `balanceAfter` of the last entry
 * before the period began — not today's balance minus the period's results,
 * which would be wrong by every deposit and withdrawal in between. "All" has
 * no start before the account's first entry, so no return is stated for it.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountAccessService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async forAccount(
    userId: string,
    accountId: string,
    period: PerformancePeriod,
    now: Date = new Date(),
  ): Promise<
    Performance & { period: PerformancePeriod; from: string | null; to: string; timeZone: string }
  > {
    const grant = await this.access.resolve(userId, accountId, Permission.POSITIONS_READ);
    const from = startOf(period, now);
    const timeZone = this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true });

    const trades = await this.prisma.trade.findMany({
      where: { accountId, exitTime: { ...(from === null ? {} : { gte: from }), lte: now } },
      select: { side: true, netPnl: true, exitTime: true },
      take: PERFORMANCE_TRADE_LIMIT + 1,
    });
    if (trades.length > PERFORMANCE_TRADE_LIMIT) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `More than ${PERFORMANCE_TRADE_LIMIT} trades closed in this period. Choose a shorter one.`,
      );
    }

    const before =
      from === null
        ? null
        : await this.prisma.balanceLedger.findFirst({
            where: { accountId, createdAt: { lt: from } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { balanceAfter: true },
          });

    const result = performanceOf({
      trades: trades.map((trade) => ({
        side: trade.side,
        netPnl: trade.netPnl.toString(),
        exitTime: trade.exitTime,
      })),
      currency: grant.account.currency as CurrencyCode,
      timeZone,
      startingBalance: before === null ? null : before.balanceAfter.toString(),
    });
    return {
      ...result,
      period,
      from: from?.toISOString() ?? null,
      to: now.toISOString(),
      timeZone,
    };
  }
}

/** The first instant of a period ending now. */
export function startOf(period: PerformancePeriod, now: Date): Date | null {
  if (period === 'ALL') return null;
  const start = new Date(now);
  if (period === '3M') start.setUTCMonth(start.getUTCMonth() - 3);
  else start.setUTCFullYear(start.getUTCFullYear() - 1);
  return start;
}
