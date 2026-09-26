import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Money, swapAccrual, toDecimal, type SymbolSpec } from '@tp/financial-core';
import { PrismaService } from '../prisma.service';
import type { WorkerEnv } from '../env';
import { requireTenantId, withTenant, withoutTenantScope } from '@tp/tenancy';

export interface SwapAccrualSummary {
  /** The trading day the accrual was booked for, as YYYY-MM-DD. */
  readonly forDate: string;
  readonly nights: number;
  readonly accrued: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * Overnight financing.
 *
 * Runs once per trading day at the configured rollover. Every open position is
 * charged or credited one night of swap at the instrument's per-lot rate — three
 * nights on the configured triple-swap day, because a position held over the
 * weekend is financed for three days even though the market is shut for two.
 * Getting that wrong understates a week-long position's cost by two nights every
 * week, which compounds into a real number.
 *
 * Each accrual carries a ledger idempotency key of
 * `swap:{positionId}:{tradingDay}`, so a retried or double-scheduled job cannot
 * charge the same night twice.
 */
@Injectable()
export class SwapAccrualService {
  private readonly logger = new Logger(SwapAccrualService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly config: ConfigService<WorkerEnv, true>,
  ) {}

  /** Weekday in the trading-server timezone, 0 = Sunday. */
  private serverWeekday(at: Date): number {
    const timeZone = this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true });
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
    return Math.max(0, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday));
  }

  /** Trading day as YYYY-MM-DD in the server's timezone, for the idempotency key. */
  private tradingDay(at: Date): string {
    const timeZone = this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true });
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }

  nightsFor(at: Date): number {
    const tripleDay = this.config.getOrThrow('SWAP_TRIPLE_DAY', { infer: true });
    // A negative value disables weekend financing entirely.
    if (tripleDay < 0) return 1;
    return this.serverWeekday(at) === tripleDay ? 3 : 1;
  }

  async accrue(at: Date = new Date()): Promise<SwapAccrualSummary> {
    const forDate = this.tradingDay(at);
    const nights = this.nightsFor(at);

    /**
     * Every open position on the platform, across every tenant.
     *
     * Financing is charged on the calendar, not on whose firm holds the
     * position, so the sweep is genuinely cross-tenant — and says so. Each
     * accrual is then written inside the position's own tenant, so a bug in the
     * posting path cannot put one firm's charge on another's ledger.
     */
    const positions = await withoutTenantScope(
      'overnight financing is charged on every open position, whichever tenant holds it',
      () =>
        this.prisma.position.findMany({
          where: { status: 'OPEN' },
          include: { account: true, symbol: { include: { spec: true } } },
        }),
    );

    let accrued = 0;
    let skipped = 0;
    let failed = 0;

    for (const position of positions) {
      const specRow = position.symbol.spec;
      if (specRow === null) {
        this.logger.error(`${position.symbol.code} has no specification; swap not accrued`);
        failed += 1;
        continue;
      }

      // The worker has no market feed and therefore no FX rate. Rather than
      // guess one, a cross-currency instrument is skipped and reported: an
      // invented rate would put a wrong number straight into the ledger.
      if (position.symbol.quoteCurrency !== position.account.currency) {
        this.logger.warn(
          `Skipping swap for ${position.symbol.code} (${position.symbol.quoteCurrency}) on a ${position.account.currency} account: no conversion rate is available in the worker`,
        );
        skipped += 1;
        continue;
      }

      const spec = toSpec(position.symbol.code, position.symbol.quoteCurrency, specRow);
      const amount = swapAccrual(
        spec,
        position.side,
        position.volume.toString(),
        nights,
        position.account.currency,
        '1',
      );

      if (amount.isZero()) {
        skipped += 1;
        continue;
      }

      try {
        await withTenant({ tenantId: position.tenantId, slug: position.tenantId }, () =>
          this.postAccrual(
            position.id,
            position.accountId,
            position.tenantId,
            amount,
            forDate,
            nights,
          ),
        );
        accrued += 1;
      } catch (error) {
        this.logger.error(
          { err: error, positionId: position.id },
          'Swap accrual failed for a position',
        );
        failed += 1;
      }
    }

    this.logger.log(
      `Swap accrual for ${forDate}: ${accrued} accrued, ${skipped} skipped, ${failed} failed (${nights} night(s))`,
    );
    return { forDate, nights, accrued, skipped, failed };
  }

  /**
   * One position's accrual: the ledger entry and the position's running swap
   * total move together, or neither does.
   */
  private async postAccrual(
    positionId: string,
    accountId: string,
    tenantId: string,
    amount: Money,
    forDate: string,
    nights: number,
  ): Promise<void> {
    const idempotencyKey = `swap:${positionId}:${forDate}`;

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.balanceLedger.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: requireTenantId(), idempotencyKey } },
      });
      if (existing !== null) return;

      const locked = await tx.$queryRaw<Array<{ balance: string; currency: string }>>`
        SELECT balance::text AS balance, currency FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE
      `;
      const account = locked[0];
      if (account === undefined) throw new Error(`Account ${accountId} disappeared mid-accrual`);

      /**
       * Round once, then apply what was rounded — `LedgerService.post`'s rule.
       * This used to store `amount.round()` and separately round
       * `balance + amount`, which disagree whenever the accrual is not a whole
       * cent: 0.15 lots at −12.50 recorded −1.88 and moved the balance −1.87.
       */
      const charged = amount.round();
      const after = Money.of(account.balance, account.currency).plus(charged);

      await tx.balanceLedger.create({
        data: {
          tenantId,
          accountId,
          type: 'SWAP',
          amount: charged.toString(),
          balanceAfter: after.toString(),
          currency: account.currency,
          referenceType: 'Position',
          referenceId: positionId,
          idempotencyKey,
          description: `Overnight financing, ${nights} night(s), ${forDate}`,
        },
      });
      await tx.account.update({
        where: { id: accountId },
        data: { balance: after.toString(), version: { increment: 1 } },
      });
      // The position's own swap total tracks what it has been charged, so a
      // partial close can release the right proportion of it.
      await tx.position.update({
        where: { id: positionId },
        data: { swap: { increment: charged.toString() } },
      });
    });
  }
}

function toSpec(
  code: string,
  quoteCurrency: string,
  row: {
    contractSize: { toString(): string };
    tickSize: { toString(): string };
    pricePrecision: number;
    volumeStep: { toString(): string };
    volumePrecision: number;
    minVolume: { toString(): string };
    maxVolume: { toString(): string };
    marginRate: { toString(): string };
    commissionPerLot: { toString(): string };
    swapLongPerLot: { toString(): string };
    swapShortPerLot: { toString(): string };
  },
): SymbolSpec {
  return {
    code,
    description: code,
    quoteCurrency,
    contractSize: row.contractSize.toString(),
    tickSize: row.tickSize.toString(),
    pricePrecision: row.pricePrecision,
    volumeStep: row.volumeStep.toString(),
    volumePrecision: row.volumePrecision,
    minVolume: row.minVolume.toString(),
    maxVolume: row.maxVolume.toString(),
    marginRate: row.marginRate.toString(),
    commissionPerLot: row.commissionPerLot.toString(),
    swapLongPerLot: row.swapLongPerLot.toString(),
    swapShortPerLot: row.swapShortPerLot.toString(),
    enabled: true,
  };
}

/** Exported for tests: whether a swap rate is worth posting at all. */
export function isMaterial(perLot: string): boolean {
  return !toDecimal(perLot).isZero();
}
