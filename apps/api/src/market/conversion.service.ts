import { Injectable } from '@nestjs/common';
import { toDecimal, type Decimal } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from './quote.service';

/**
 * Converts an amount from an instrument's quote currency into an account's
 * currency.
 *
 * Three cases, in order:
 *
 *  1. Same currency — the rate is exactly 1.
 *  2. A quoted pair exists in either direction — use the mid of the current
 *     quote. The mid is right here and wrong for execution: a currency
 *     conversion is not a trade the platform is executing, so there is no side
 *     of the book to cross.
 *  3. Neither — throw. Inventing a rate would corrupt the P&L of every position
 *     it touched, and a wrong number is worse than a refused order.
 */
@Injectable()
export class ConversionService {
  constructor(
    private readonly symbols: SymbolsService,
    private readonly quotes: QuoteService,
  ) {}

  async rate(from: string, to: string): Promise<Decimal> {
    const source = from.toUpperCase();
    const target = to.toUpperCase();
    if (source === target) return toDecimal(1);

    const direct = await this.midOf(`${source}${target}`);
    if (direct !== null) return direct;

    const inverse = await this.midOf(`${target}${source}`);
    if (inverse !== null) {
      if (inverse.isZero()) {
        throw new DomainError(
          TradingErrorCode.NO_QUOTE_AVAILABLE,
          `The ${target}${source} quote is zero and cannot be inverted`,
        );
      }
      return toDecimal(1).div(inverse);
    }

    throw new DomainError(
      TradingErrorCode.NOT_IMPLEMENTED,
      `No conversion rate is available from ${source} to ${target}. Add a quoted ${source}${target} instrument or a rate source.`,
      { from: source, to: target },
    );
  }

  private async midOf(code: string): Promise<Decimal | null> {
    if (this.symbols.find(code) === undefined) return null;
    const tick = await this.quotes.latest(code);
    if (tick === null) return null;
    return toDecimal(tick.bid).plus(toDecimal(tick.ask)).div(2);
  }
}
