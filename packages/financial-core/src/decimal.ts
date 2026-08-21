import DecimalJs from 'decimal.js';

/**
 * The single configured Decimal constructor for the whole platform.
 *
 * Nothing outside this module may call `decimal.js` directly — importing the
 * raw library would silently bypass this configuration and produce a different
 * rounding behaviour in one corner of the codebase.
 *
 *  - precision 40: far beyond any instrument's needs, so intermediate results
 *    (e.g. price x contractSize x volume / leverage) never lose digits before
 *    the single, explicit rounding step at the end.
 *  - toExpNeg/toExpPos pushed out: `toString()` must never produce exponent
 *    notation, because those strings go onto the wire and into NUMERIC columns.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  toExpNeg: -40,
  toExpPos: 40,
  rounding: DecimalJs.ROUND_HALF_UP,
});

export type Decimal = InstanceType<typeof Decimal>;

/** Any value that can be interpreted as an exact decimal. Never a float literal. */
export type DecimalInput = string | number | Decimal;

export const ZERO: Decimal = new Decimal(0);
export const ONE: Decimal = new Decimal(1);

/**
 * Numbers are accepted only when they are integers that survive the round trip
 * exactly. `0.1` as a JS number is already not 0.1; letting it in here would
 * defeat the entire point of using decimals.
 */
export function toDecimal(value: DecimalInput): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number cannot be a decimal: ${value}`);
    }
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `Refusing to build a Decimal from the non-integer number ${value}. ` +
          `Pass a string (e.g. '${value}') so the exact value is preserved.`,
      );
    }
    return new Decimal(value);
  }
  return new Decimal(value);
}

export function isDecimalString(value: string): boolean {
  if (value.trim() === '') return false;
  try {
    const d = new Decimal(value);
    return d.isFinite();
  } catch {
    return false;
  }
}
