import { Decimal, type DecimalInput, ONE, toDecimal } from '../decimal';
import type { SymbolSpec } from '../instrument';
import { notionalValue } from '../instrument';
import { Money } from '../money';
import type { CurrencyCode } from '../currency';

export interface MarginInput {
  readonly spec: SymbolSpec;
  readonly volume: DecimalInput;
  /** Price the margin is computed against — the entry price for a new order. */
  readonly price: DecimalInput;
  /** Account leverage, e.g. 100 for 100:1. */
  readonly accountLeverage: DecimalInput;
  readonly accountCurrency: CurrencyCode;
  readonly quoteToAccountRate: DecimalInput;
}

/**
 * The margin rate actually applied.
 *
 * The instrument's own rate is a floor: an account with 500:1 leverage still
 * posts the instrument's required margin on a symbol capped at 100:1. Taking
 * the larger of the two is what makes per-symbol risk limits enforceable.
 */
export function effectiveMarginRate(spec: SymbolSpec, accountLeverage: DecimalInput): Decimal {
  const leverage = toDecimal(accountLeverage);
  if (leverage.lte(0))
    throw new RangeError(`Account leverage must be positive, got ${leverage.toString()}`);
  const fromLeverage = ONE.div(leverage);
  const fromSpec = toDecimal(spec.marginRate);
  return Decimal.max(fromLeverage, fromSpec);
}

/** Initial margin required to open the position, in the account's currency. */
export function requiredMargin(input: MarginInput): Money {
  const rate = effectiveMarginRate(input.spec, input.accountLeverage);
  const notionalInQuote = notionalValue(input.spec, input.volume, input.price);
  return Money.of(notionalInQuote.mul(rate), input.spec.quoteCurrency).convertTo(
    input.accountCurrency,
    input.quoteToAccountRate,
  );
}

/**
 * Largest volume the given free margin supports, snapped down to the lot step
 * by the caller via `normalizeVolume`. Returned unsnapped so the caller decides
 * the rounding policy.
 */
export function maxVolumeForMargin(
  freeMargin: Money,
  spec: SymbolSpec,
  price: DecimalInput,
  accountLeverage: DecimalInput,
  quoteToAccountRate: DecimalInput,
): Decimal {
  if (!freeMargin.isPositive()) return toDecimal(0);
  const rate = effectiveMarginRate(spec, accountLeverage);
  const perLotInQuote = toDecimal(spec.contractSize).mul(toDecimal(price)).mul(rate);
  const perLotInAccount = perLotInQuote.mul(toDecimal(quoteToAccountRate));
  if (perLotInAccount.lte(0)) return toDecimal(0);
  return freeMargin.amount.div(perLotInAccount);
}
