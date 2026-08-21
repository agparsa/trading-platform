import { CloseReason, DomainError, type OrderSide, TradingErrorCode } from '@tp/shared-types';
import {
  exitPriceFor,
  isOnGrid,
  normalizePrice,
  type SymbolSpec,
  toDecimal,
} from '@tp/financial-core';

export interface ProtectiveLevels {
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
}

export interface Quote {
  readonly bid: string;
  readonly ask: string;
}

/**
 * Validate stop-loss / take-profit levels against the side of the position.
 *
 * A stop-loss placed on the profitable side of the market is not a harmless
 * typo — it fires instantly on the next tick and closes the position the trader
 * just opened. It is rejected at the boundary instead.
 *
 * `reference` is the price the levels are measured against: the intended entry
 * price for a new order, or the current executable exit price for an existing
 * position.
 */
export function validateProtectiveLevels(
  spec: SymbolSpec,
  side: OrderSide,
  reference: string,
  levels: ProtectiveLevels,
): void {
  const ref = toDecimal(reference);

  if (levels.stopLoss !== null) {
    const sl = toDecimal(levels.stopLoss);
    if (sl.lte(0)) {
      throw new DomainError(
        TradingErrorCode.INVALID_STOP_LOSS,
        'Stop loss must be a positive price',
      );
    }
    if (!isOnGrid(sl, spec.tickSize)) {
      throw new DomainError(
        TradingErrorCode.INVALID_STOP_LOSS,
        `Stop loss ${levels.stopLoss} is not a multiple of the ${spec.code} tick size ${spec.tickSize}`,
        { tickSize: spec.tickSize },
      );
    }
    const wrongSide = side === 'BUY' ? sl.gte(ref) : sl.lte(ref);
    if (wrongSide) {
      throw new DomainError(
        TradingErrorCode.INVALID_STOP_LOSS,
        `A ${side} stop loss must sit ${side === 'BUY' ? 'below' : 'above'} ${ref.toString()}`,
        { side, reference: ref.toString(), stopLoss: levels.stopLoss },
      );
    }
  }

  if (levels.takeProfit !== null) {
    const tp = toDecimal(levels.takeProfit);
    if (tp.lte(0)) {
      throw new DomainError(
        TradingErrorCode.INVALID_TAKE_PROFIT,
        'Take profit must be a positive price',
      );
    }
    if (!isOnGrid(tp, spec.tickSize)) {
      throw new DomainError(
        TradingErrorCode.INVALID_TAKE_PROFIT,
        `Take profit ${levels.takeProfit} is not a multiple of the ${spec.code} tick size ${spec.tickSize}`,
        { tickSize: spec.tickSize },
      );
    }
    const wrongSide = side === 'BUY' ? tp.lte(ref) : tp.gte(ref);
    if (wrongSide) {
      throw new DomainError(
        TradingErrorCode.INVALID_TAKE_PROFIT,
        `A ${side} take profit must sit ${side === 'BUY' ? 'above' : 'below'} ${ref.toString()}`,
        { side, reference: ref.toString(), takeProfit: levels.takeProfit },
      );
    }
  }
}

/**
 * Decide whether a quote triggers a protective level.
 *
 * Triggering is evaluated on the *executable exit* price — the bid for a long,
 * the ask for a short — because that is the price the position would actually
 * be closed at. Using the mid or the entry side would fire stops late for longs
 * and early for shorts.
 *
 * Stop-loss is checked before take-profit: when a single tick spans both levels
 * we cannot know the intra-tick path, so the platform resolves the ambiguity
 * against the trader's favour consistently rather than at random.
 */
export function evaluateProtectiveTrigger(
  side: OrderSide,
  levels: ProtectiveLevels,
  quote: Quote,
): CloseReason | null {
  const exit = exitPriceFor(side, quote);

  if (levels.stopLoss !== null) {
    const sl = toDecimal(levels.stopLoss);
    const hit = side === 'BUY' ? exit.lte(sl) : exit.gte(sl);
    if (hit) return CloseReason.STOP_LOSS;
  }

  if (levels.takeProfit !== null) {
    const tp = toDecimal(levels.takeProfit);
    const hit = side === 'BUY' ? exit.gte(tp) : exit.lte(tp);
    if (hit) return CloseReason.TAKE_PROFIT;
  }

  return null;
}

/**
 * New trailing-stop level after a tick, or `null` when it should not move.
 *
 * A trailing stop only ever moves in the trader's favour. `highWater` is the
 * best exit price seen so far; the stop sits `distance` behind it.
 */
export function nextTrailingStop(
  spec: SymbolSpec,
  side: OrderSide,
  distance: string,
  highWater: string,
  currentStop: string | null,
): string | null {
  const d = toDecimal(distance);
  if (d.lte(0)) {
    throw new DomainError(TradingErrorCode.INVALID_STOP_LOSS, 'Trailing distance must be positive');
  }
  const anchor = toDecimal(highWater);
  const candidate = normalizePrice(spec, side === 'BUY' ? anchor.minus(d) : anchor.plus(d));

  if (currentStop === null) return candidate.toString();
  const current = toDecimal(currentStop);
  const improves = side === 'BUY' ? candidate.gt(current) : candidate.lt(current);
  return improves ? candidate.toString() : null;
}

/** Update the best-seen exit price that a trailing stop follows. */
export function nextHighWater(side: OrderSide, highWater: string | null, quote: Quote): string {
  const exit = exitPriceFor(side, quote);
  if (highWater === null) return exit.toString();
  const current = toDecimal(highWater);
  const better = side === 'BUY' ? exit.gt(current) : exit.lt(current);
  return better ? exit.toString() : current.toString();
}
