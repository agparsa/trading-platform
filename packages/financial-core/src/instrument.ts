import { type Decimal, type DecimalInput, toDecimal } from './decimal';
import { isOnGrid, quantize, RoundingMode } from './rounding';
import type { CurrencyCode } from './currency';

/**
 * Contract specification for one tradeable instrument.
 *
 * Every price and volume calculation in the platform is parameterised by this
 * object. No formula may assume "2 decimal places" or "100,000 units per lot" —
 * those are properties of the instrument, configured in the database.
 */
export interface SymbolSpec {
  /** Public code, e.g. 'XAUUSD'. */
  readonly code: string;
  readonly description: string;
  /** Currency the instrument is priced in — the currency raw P&L lands in. */
  readonly quoteCurrency: CurrencyCode;
  /** Units of the underlying per 1.00 lot. e.g. 100 for XAUUSD, 100000 for EURUSD. */
  readonly contractSize: string;
  /** Smallest price increment, e.g. '0.01'. */
  readonly tickSize: string;
  /** Display/storage precision for prices. Must be consistent with tickSize. */
  readonly pricePrecision: number;
  /** Smallest tradeable volume increment in lots, e.g. '0.01'. */
  readonly volumeStep: string;
  readonly volumePrecision: number;
  readonly minVolume: string;
  readonly maxVolume: string;
  /** Initial margin as a fraction of notional, e.g. '0.01' for 1% (100:1). */
  readonly marginRate: string;
  /** Commission per lot per side, in quoteCurrency. '0' when spread-only. */
  readonly commissionPerLot: string;
  /** Long/short overnight financing per lot per night, in quoteCurrency. */
  readonly swapLongPerLot: string;
  readonly swapShortPerLot: string;
  readonly enabled: boolean;
}

export class InstrumentSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstrumentSpecError';
  }
}

/**
 * Validates that a spec is internally consistent. Called once when a symbol is
 * loaded, so every later calculation can trust it.
 */
export function assertValidSpec(spec: SymbolSpec): void {
  const positive: Array<[string, string]> = [
    ['contractSize', spec.contractSize],
    ['tickSize', spec.tickSize],
    ['volumeStep', spec.volumeStep],
    ['minVolume', spec.minVolume],
    ['maxVolume', spec.maxVolume],
    ['marginRate', spec.marginRate],
  ];
  for (const [field, value] of positive) {
    if (toDecimal(value).lte(0)) {
      throw new InstrumentSpecError(`${spec.code}: ${field} must be positive, got ${value}`);
    }
  }
  if (toDecimal(spec.minVolume).gt(toDecimal(spec.maxVolume))) {
    throw new InstrumentSpecError(`${spec.code}: minVolume exceeds maxVolume`);
  }
  if (!isOnGrid(spec.minVolume, spec.volumeStep)) {
    throw new InstrumentSpecError(
      `${spec.code}: minVolume ${spec.minVolume} is not a multiple of volumeStep ${spec.volumeStep}`,
    );
  }
  // A tick size finer than the stored precision would be silently truncated.
  const tickDecimals = toDecimal(spec.tickSize).decimalPlaces();
  if (tickDecimals > spec.pricePrecision) {
    throw new InstrumentSpecError(
      `${spec.code}: tickSize ${spec.tickSize} needs ${tickDecimals} decimals but pricePrecision is ${spec.pricePrecision}`,
    );
  }
  const stepDecimals = toDecimal(spec.volumeStep).decimalPlaces();
  if (stepDecimals > spec.volumePrecision) {
    throw new InstrumentSpecError(
      `${spec.code}: volumeStep ${spec.volumeStep} needs ${stepDecimals} decimals but volumePrecision is ${spec.volumePrecision}`,
    );
  }
}

/** Snap a price to the instrument's tick grid. Ties go away from zero. */
export function normalizePrice(spec: SymbolSpec, price: DecimalInput): Decimal {
  return quantize(price, spec.tickSize, RoundingMode.HALF_UP).toDecimalPlaces(spec.pricePrecision);
}

/**
 * Snap a volume down to the instrument's lot step.
 * Rounds DOWN deliberately: rounding a requested volume *up* would expose the
 * trader to more risk than they asked for.
 */
export function normalizeVolume(spec: SymbolSpec, volumeLots: DecimalInput): Decimal {
  return quantize(volumeLots, spec.volumeStep, RoundingMode.DOWN).toDecimalPlaces(
    spec.volumePrecision,
  );
}

export interface VolumeCheck {
  readonly ok: boolean;
  readonly reason?: 'BELOW_MIN' | 'ABOVE_MAX' | 'OFF_STEP' | 'NOT_POSITIVE';
}

export function checkVolume(spec: SymbolSpec, volumeLots: DecimalInput): VolumeCheck {
  const v = toDecimal(volumeLots);
  if (v.lte(0)) return { ok: false, reason: 'NOT_POSITIVE' };
  if (v.lt(toDecimal(spec.minVolume))) return { ok: false, reason: 'BELOW_MIN' };
  if (v.gt(toDecimal(spec.maxVolume))) return { ok: false, reason: 'ABOVE_MAX' };
  if (!isOnGrid(v, spec.volumeStep)) return { ok: false, reason: 'OFF_STEP' };
  return { ok: true };
}

/** Notional value of a position: volume x contractSize x price, in quoteCurrency. */
export function notionalValue(
  spec: SymbolSpec,
  volumeLots: DecimalInput,
  price: DecimalInput,
): Decimal {
  return toDecimal(volumeLots).mul(toDecimal(spec.contractSize)).mul(toDecimal(price));
}

/** Value of one tick for a given volume, in quoteCurrency. */
export function tickValue(spec: SymbolSpec, volumeLots: DecimalInput): Decimal {
  return toDecimal(spec.tickSize).mul(toDecimal(spec.contractSize)).mul(toDecimal(volumeLots));
}
