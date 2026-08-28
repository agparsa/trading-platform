import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  computeAccountState,
  grossPnl,
  Money,
  toDecimal,
  type AccountState,
  type Decimal,
} from '@tp/financial-core';
import type { SymbolExposure } from '@tp/risk-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.schema';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from '../market/quote.service';
import { ConversionService } from '../market/conversion.service';
import { startOfTradingDay } from '../market/session';

export interface OpenPositionValuation {
  positionId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  currentPrice: string | null;
  floatingPnl: Money;
  /** Commission already charged on this position, entry leg. */
  commission: Money;
  /** Swap accrued on this position so far. */
  swap: Money;
  /**
   * Floating P&L less the costs already charged against this position.
   *
   * Deliberately *not* an estimate of the round trip: the exit commission has
   * not been charged and inventing it would put a number on screen that no
   * ledger entry will ever match. This is the mark less what has actually been
   * paid, which is a figure the ledger can be reconciled against today.
   */
  netPnl: Money;
  margin: Money;
  /** True when the position could not be marked because no fresh price exists. */
  stale: boolean;
}

/**
 * Realized profit, which is history rather than a mark.
 *
 * Read from `trades` — the immutable record of closed round trips — and never
 * from the balance, which also moves with deposits and withdrawals.
 */
export interface RealizedPnl {
  /** Since the trading day began, in the trading server's timezone. */
  today: Money;
  /** Over the life of the account. */
  total: Money;
  /** The instant "today" started, so a client can say what window it is showing. */
  since: number;
}

export interface AccountValuation {
  accountId: string;
  currency: string;
  leverage: string;
  state: AccountState;
  positions: OpenPositionValuation[];
  exposureBySymbol: Map<string, SymbolExposure>;
  openPositionCount: number;
}

/**
 * Marks an account to market.
 *
 * This is the single place equity, used margin and floating P&L are computed for
 * a live account. Every consumer — the risk engine, the API, the WebSocket feed,
 * the stop-out check — reads the same numbers from here, so they cannot drift
 * apart.
 */
@Injectable()
export class AccountStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly symbols: SymbolsService,
    private readonly quotes: QuoteService,
    private readonly conversion: ConversionService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  async valuate(
    accountId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<AccountValuation> {
    const account = await client.account.findUnique({ where: { id: accountId } });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId,
      });
    }

    const openPositions = await client.position.findMany({
      where: { accountId, status: { in: ['OPEN', 'CLOSING'] } },
      include: { symbol: true },
    });

    const currency = account.currency;
    const valuations: OpenPositionValuation[] = [];
    const exposureBySymbol = new Map<string, SymbolExposure>();
    let floating = Money.zero(currency);
    let usedMargin = Money.zero(currency);

    for (const position of openPositions) {
      const spec = this.symbols.requireSpec(position.symbol.code);
      const margin = Money.of(position.margin.toString(), currency);
      usedMargin = usedMargin.plus(margin);

      const tick = await this.quotes.latest(position.symbol.code);
      const rate = await this.conversion.rate(spec.quoteCurrency, currency);

      let pnl = Money.zero(currency);
      let currentPrice: string | null = position.currentPrice?.toString() ?? null;
      let stale = true;

      if (tick !== null) {
        const exit = position.side === 'BUY' ? tick.bid : tick.ask;
        currentPrice = exit;
        stale = false;
        pnl = grossPnl({
          spec,
          side: position.side,
          volume: position.volume.toString(),
          entryPrice: position.entryPrice.toString(),
          exitPrice: exit,
          accountCurrency: currency,
          quoteToAccountRate: rate,
        });
      } else if (currentPrice !== null) {
        // No live tick: fall back to the last mark rather than pretending the
        // position is flat. A stale number that is labelled stale beats a zero
        // that looks authoritative.
        pnl = grossPnl({
          spec,
          side: position.side,
          volume: position.volume.toString(),
          entryPrice: position.entryPrice.toString(),
          exitPrice: currentPrice,
          accountCurrency: currency,
          quoteToAccountRate: rate,
        });
      }

      floating = floating.plus(pnl);
      const commission = Money.of(position.commission.toString(), currency);
      const swap = Money.of(position.swap.toString(), currency);
      valuations.push({
        positionId: position.id,
        symbol: position.symbol.code,
        side: position.side,
        volume: position.volume.toString(),
        entryPrice: position.entryPrice.toString(),
        currentPrice,
        floatingPnl: pnl,
        commission,
        swap,
        // Swap is stored signed — a credit is positive — so it is added, and
        // commission, always a charge, is subtracted. This mirrors `netPnl` on
        // a closed trade exactly, minus the exit leg that has not happened.
        netPnl: pnl.minus(commission).plus(swap),
        margin,
        stale,
      });

      const priceForNotional = currentPrice ?? position.entryPrice.toString();
      const notional = Money.of(
        toDecimal(position.volume.toString())
          .mul(toDecimal(spec.contractSize))
          .mul(toDecimal(priceForNotional)),
        spec.quoteCurrency,
      ).convertTo(currency, rate);

      const existing = exposureBySymbol.get(position.symbol.code);
      const signed = toDecimal(position.volume.toString()).mul(position.side === 'BUY' ? 1 : -1);
      exposureBySymbol.set(position.symbol.code, {
        symbol: position.symbol.code,
        netVolume: (existing === undefined
          ? signed
          : toDecimal(existing.netVolume).plus(signed)
        ).toString(),
        grossNotional: existing === undefined ? notional : existing.grossNotional.plus(notional),
      });
    }

    const state = computeAccountState({
      currency,
      balance: Money.of(account.balance.toString(), currency),
      floatingPnl: floating,
      usedMargin,
    });

    return {
      accountId,
      currency,
      leverage: account.leverage.toString(),
      state,
      positions: valuations,
      exposureBySymbol,
      openPositionCount: openPositions.length,
    };
  }

  /**
   * Realized profit for an account.
   *
   * Kept out of `valuate()` on purpose. `valuate()` runs inside the
   * transactions that open and close positions, and inside the tick loop; every
   * query added to it lengthens a lock window or the per-tick cost. Realized
   * P&L is display data — nothing decides anything from it — so it is a
   * separate call made only by the surfaces that show it.
   *
   * Summed from `trades` rather than inferred from the balance: the balance
   * also moves with deposits and withdrawals, and a "profit" figure that
   * counts a deposit is worse than none.
   */
  async realized(
    accountId: string,
    currency: string,
    nowMs = Date.now(),
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<RealizedPnl> {
    const since = startOfTradingDay(
      this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true }),
      nowMs,
    );
    const [today, total] = await Promise.all([
      client.trade.aggregate({
        where: { accountId, exitTime: { gte: new Date(since) } },
        _sum: { netPnl: true },
      }),
      client.trade.aggregate({ where: { accountId }, _sum: { netPnl: true } }),
    ]);
    return {
      today: Money.of(today._sum.netPnl?.toString() ?? '0', currency),
      total: Money.of(total._sum.netPnl?.toString() ?? '0', currency),
      since,
    };
  }

  /**
   * Wire representation of a valuation, for REST and WebSocket.
   *
   * `realized` is optional because the tick path does not pay for it. A client
   * that receives a frame without it keeps the last value it had rather than
   * showing a zero — the field is absent, not zero, and those mean different
   * things.
   */
  toDto(valuation: AccountValuation, realized?: RealizedPnl): Record<string, unknown> {
    const { state } = valuation;
    let grossExposure = Money.zero(valuation.currency);
    for (const exposure of valuation.exposureBySymbol.values()) {
      grossExposure = grossExposure.plus(exposure.grossNotional);
    }
    return {
      accountId: valuation.accountId,
      currency: valuation.currency,
      balance: state.balance.toString(),
      equity: state.equity.toString(),
      floatingPnl: state.floatingPnl.toString(),
      usedMargin: state.usedMargin.toString(),
      freeMargin: state.freeMargin.toString(),
      marginLevel: formatRatio(state.marginLevel),
      /**
       * Margin in use as a share of equity — the inverse view of margin level,
       * and the one traders read as "how much of the account is committed".
       *
       * `null` rather than a number when equity is not positive: a ratio over a
       * non-positive denominator is not a percentage, and rendering one would
       * be worse than rendering nothing.
       */
      marginUtilisation: formatRatio(
        state.equity.amount.lte(0)
          ? null
          : state.usedMargin.amount.div(state.equity.amount).mul(100),
      ),
      /** Sum of absolute notional across open positions, in account currency. */
      grossExposure: grossExposure.toString(),
      openPositions: valuation.openPositionCount,
      ...(realized === undefined
        ? {}
        : {
            realizedPnlToday: realized.today.toString(),
            realizedPnlTotal: realized.total.toString(),
            realizedSince: realized.since,
          }),
      updatedAt: Date.now(),
    };
  }
}

/** Percentages are strings too, and `null` stays `null` rather than becoming 0. */
function formatRatio(value: Decimal | null): string | null {
  return value === null ? null : value.toDecimalPlaces(2).toString();
}
