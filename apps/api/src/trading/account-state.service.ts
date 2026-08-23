import { Injectable } from '@nestjs/common';
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
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from '../market/quote.service';
import { ConversionService } from '../market/conversion.service';

export interface OpenPositionValuation {
  positionId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: string;
  entryPrice: string;
  currentPrice: string | null;
  floatingPnl: Money;
  margin: Money;
  /** True when the position could not be marked because no fresh price exists. */
  stale: boolean;
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
      valuations.push({
        positionId: position.id,
        symbol: position.symbol.code,
        side: position.side,
        volume: position.volume.toString(),
        entryPrice: position.entryPrice.toString(),
        currentPrice,
        floatingPnl: pnl,
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

  /** Wire representation of a valuation, for REST and WebSocket. */
  toDto(valuation: AccountValuation): Record<string, unknown> {
    const { state } = valuation;
    return {
      accountId: valuation.accountId,
      currency: valuation.currency,
      balance: state.balance.toString(),
      equity: state.equity.toString(),
      floatingPnl: state.floatingPnl.toString(),
      usedMargin: state.usedMargin.toString(),
      freeMargin: state.freeMargin.toString(),
      marginLevel: formatRatio(state.marginLevel),
      openPositions: valuation.openPositionCount,
      updatedAt: Date.now(),
    };
  }
}

/** Percentages are strings too, and `null` stays `null` rather than becoming 0. */
function formatRatio(value: Decimal | null): string | null {
  return value === null ? null : value.toDecimalPlaces(2).toString();
}
