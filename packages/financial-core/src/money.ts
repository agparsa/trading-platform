import { type Decimal, type DecimalInput, toDecimal } from './decimal';
import { minorUnits, type CurrencyCode } from './currency';
import { DEFAULT_MONEY_ROUNDING, roundTo, type RoundingMode } from './rounding';

/**
 * An exact monetary amount in a specific currency.
 *
 * Immutable. Every operation returns a new instance. Mixing currencies throws
 * rather than coercing — an implicit FX conversion is exactly the kind of
 * silent error this type exists to prevent.
 *
 * Internally the amount is kept at full precision; rounding happens only when
 * the value is persisted or displayed, via `round()` / `toString()`.
 */
export class Money {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.amount = amount;
    this.currency = currency;
  }

  static of(amount: DecimalInput, currency: CurrencyCode): Money {
    minorUnits(currency); // validates the currency is known
    return new Money(toDecimal(amount), currency.toUpperCase());
  }

  static zero(currency: CurrencyCode): Money {
    return Money.of(0, currency);
  }

  private assertSameCurrency(other: Money, op: string): void {
    if (this.currency !== other.currency) {
      throw new TypeError(
        `Cannot ${op} ${this.currency} and ${other.currency}. Convert explicitly with an FX rate first.`,
      );
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Scale by a dimensionless factor (a ratio, not another monetary amount). */
  times(factor: DecimalInput): Money {
    return new Money(this.amount.mul(toDecimal(factor)), this.currency);
  }

  dividedBy(divisor: DecimalInput): Money {
    const d = toDecimal(divisor);
    if (d.isZero()) throw new RangeError('Division of a monetary amount by zero');
    return new Money(this.amount.div(d), this.currency);
  }

  negated(): Money {
    return new Money(this.amount.neg(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  /**
   * Convert into another currency at an explicit rate.
   * `rate` is quoted as: 1 unit of this currency = `rate` units of `target`.
   */
  convertTo(target: CurrencyCode, rate: DecimalInput): Money {
    const r = toDecimal(rate);
    if (r.lte(0)) throw new RangeError(`FX rate must be positive, got ${r.toString()}`);
    return Money.of(this.amount.mul(r), target);
  }

  /** Round to the currency's minor units. This is the settlement value. */
  round(mode: RoundingMode = DEFAULT_MONEY_ROUNDING): Money {
    return new Money(roundTo(this.amount, minorUnits(this.currency), mode), this.currency);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }
  isPositive(): boolean {
    return this.amount.gt(0);
  }
  isNegative(): boolean {
    return this.amount.lt(0);
  }
  gt(other: Money): boolean {
    this.assertSameCurrency(other, 'compare');
    return this.amount.gt(other.amount);
  }
  gte(other: Money): boolean {
    this.assertSameCurrency(other, 'compare');
    return this.amount.gte(other.amount);
  }
  lt(other: Money): boolean {
    this.assertSameCurrency(other, 'compare');
    return this.amount.lt(other.amount);
  }
  lte(other: Money): boolean {
    this.assertSameCurrency(other, 'compare');
    return this.amount.lte(other.amount);
  }
  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.eq(other.amount);
  }

  static sum(items: readonly Money[], currency: CurrencyCode): Money {
    return items.reduce((acc, m) => acc.plus(m), Money.zero(currency));
  }

  /** Wire/DB representation: a rounded decimal string, never a JS number. */
  toString(): string {
    return this.round().amount.toFixed(minorUnits(this.currency));
  }

  /** Full-precision string, for intermediate values that must not be rounded yet. */
  toExactString(): string {
    return this.amount.toString();
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }
}
