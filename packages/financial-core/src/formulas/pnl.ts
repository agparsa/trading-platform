import { type Decimal, type DecimalInput, ONE, toDecimal } from '../decimal';
import type { SymbolSpec } from '../instrument';
import { Money } from '../money';
import type { CurrencyCode } from '../currency';
import { directionOf, type Side } from './sides';

export interface PnlInput {
  readonly spec: SymbolSpec;
  readonly side: Side;
  /** Volume in lots. */
  readonly volume: DecimalInput;
  readonly entryPrice: DecimalInput;
  /** Executable exit price — BID for a long, ASK for a short. See `sides.ts`. */
  readonly exitPrice: DecimalInput;
  /** Account currency the result must be expressed in. */
  readonly accountCurrency: CurrencyCode;
  /**
   * 1 unit of `spec.quoteCurrency` = this many units of `accountCurrency`.
   * Pass '1' when they are the same currency. Never defaulted implicitly: a
   * missing conversion rate is a bug we want to surface, not paper over.
   */
  readonly quoteToAccountRate: DecimalInput;
}

/**
 * Price P&L of a position, in the account's currency, at full precision.
 * Rounding happens once, at the point of settlement — not here.
 */
export function grossPnl(input: PnlInput): Money {
  const { spec, side, volume, entryPrice, exitPrice } = input;
  const move = toDecimal(exitPrice).minus(toDecimal(entryPrice)).mul(directionOf(side));
  const inQuote = move.mul(toDecimal(spec.contractSize)).mul(toDecimal(volume));
  return Money.of(inQuote, spec.quoteCurrency).convertTo(
    input.accountCurrency,
    input.quoteToAccountRate,
  );
}

/**
 * Commission for one leg (open or close). Always a cost, so the returned Money
 * is non-negative; callers subtract it.
 */
export function commissionForLeg(
  spec: SymbolSpec,
  volume: DecimalInput,
  accountCurrency: CurrencyCode,
  quoteToAccountRate: DecimalInput,
): Money {
  const inQuote = toDecimal(spec.commissionPerLot).mul(toDecimal(volume)).abs();
  return Money.of(inQuote, spec.quoteCurrency).convertTo(accountCurrency, quoteToAccountRate);
}

/**
 * Overnight financing accrued over `nights`. Signed: positive credits the
 * account, negative debits it, exactly as the instrument's swap rate is stored.
 */
export function swapAccrual(
  spec: SymbolSpec,
  side: Side,
  volume: DecimalInput,
  nights: number,
  accountCurrency: CurrencyCode,
  quoteToAccountRate: DecimalInput,
): Money {
  if (!Number.isInteger(nights) || nights < 0) {
    throw new RangeError(`nights must be a non-negative integer, got ${nights}`);
  }
  const perLot = side === 'BUY' ? spec.swapLongPerLot : spec.swapShortPerLot;
  const inQuote = toDecimal(perLot).mul(toDecimal(volume)).mul(nights);
  return Money.of(inQuote, spec.quoteCurrency).convertTo(accountCurrency, quoteToAccountRate);
}

export interface NetPnlInput extends PnlInput {
  /** Total commission already charged or about to be charged, as a positive cost. */
  readonly commission: Money;
  /** Signed swap accrual: positive credits, negative debits. */
  readonly swap: Money;
}

/**
 * Realized result of a closed position:
 *   net = gross - commission + swap
 * Swap is added because it is stored signed; commission is subtracted because
 * it is stored as a magnitude.
 */
export function netPnl(input: NetPnlInput): Money {
  return grossPnl(input).minus(input.commission).plus(input.swap);
}

/** Return on the notional committed at entry, as a ratio (0.05 = +5%). */
export function returnOnNotional(input: PnlInput): Decimal {
  const notional = toDecimal(input.entryPrice)
    .mul(toDecimal(input.spec.contractSize))
    .mul(toDecimal(input.volume));
  if (notional.isZero()) return toDecimal(0);
  const gross = grossPnl(input);
  const notionalInAccount = notional.mul(toDecimal(input.quoteToAccountRate));
  return gross.amount.div(notionalInAccount);
}

/**
 * Price at which a position's gross P&L is exactly zero, given a per-lot cost
 * to recover (commission, accrued swap). Used for break-even display and for
 * validating that a stop-loss is not placed on the wrong side of entry.
 */
export function breakEvenPrice(
  spec: SymbolSpec,
  side: Side,
  volume: DecimalInput,
  entryPrice: DecimalInput,
  costsInQuoteCurrency: DecimalInput,
): Decimal {
  const perUnit = toDecimal(spec.contractSize).mul(toDecimal(volume));
  if (perUnit.isZero())
    throw new RangeError('Volume must be positive to compute a break-even price');
  const offset = toDecimal(costsInQuoteCurrency).div(perUnit).mul(ONE);
  return toDecimal(entryPrice).plus(offset.mul(directionOf(side)));
}
