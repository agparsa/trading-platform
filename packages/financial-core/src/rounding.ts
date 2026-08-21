import { Decimal, type DecimalInput, toDecimal } from './decimal';

/**
 * Rounding modes are named explicitly rather than passed as decimal.js magic
 * numbers, so a code review can see which convention a call site chose.
 */
export const RoundingMode = {
  /** 2.5 -> 3, -2.5 -> -3. The default for money in this system. */
  HALF_UP: Decimal.ROUND_HALF_UP,
  /** Banker's rounding: 2.5 -> 2, 3.5 -> 4. Removes systematic upward bias. */
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  /** Always toward zero. Used when quantizing volume to a tradeable step. */
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  FLOOR: Decimal.ROUND_FLOOR,
  CEIL: Decimal.ROUND_CEIL,
} as const;
export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

export const DEFAULT_MONEY_ROUNDING: RoundingMode = RoundingMode.HALF_UP;

/** Round to a fixed number of decimal places. */
export function roundTo(
  value: DecimalInput,
  decimalPlaces: number,
  mode: RoundingMode = DEFAULT_MONEY_ROUNDING,
): Decimal {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
    throw new RangeError(`decimalPlaces must be a non-negative integer, got ${decimalPlaces}`);
  }
  return toDecimal(value).toDecimalPlaces(decimalPlaces, mode);
}

/**
 * Snap a value onto a discrete grid — the only correct way to normalise a price
 * to an instrument's tick size or a volume to its lot step. Rounding to a digit
 * count is not equivalent: a 0.05 tick size is not expressible as a digit count.
 */
export function quantize(
  value: DecimalInput,
  step: DecimalInput,
  mode: RoundingMode = RoundingMode.DOWN,
): Decimal {
  const v = toDecimal(value);
  const s = toDecimal(step);
  if (s.lte(0)) throw new RangeError(`Quantization step must be positive, got ${s.toString()}`);
  return v.div(s).toDecimalPlaces(0, mode).mul(s);
}

/** True when `value` sits exactly on the `step` grid. */
export function isOnGrid(value: DecimalInput, step: DecimalInput): boolean {
  const s = toDecimal(step);
  if (s.lte(0)) throw new RangeError(`Quantization step must be positive, got ${s.toString()}`);
  return toDecimal(value).mod(s).isZero();
}
