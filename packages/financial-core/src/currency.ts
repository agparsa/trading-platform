/**
 * Minor-unit exponents for the currencies the platform settles in.
 * Sourced from ISO 4217. Extend deliberately — an unknown currency must fail
 * loudly rather than silently defaulting to 2 decimal places.
 */
const MINOR_UNITS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  AUD: 2,
  CAD: 2,
  NZD: 2,
  JPY: 0,
  KRW: 0,
};

export type CurrencyCode = string;

export function minorUnits(currency: CurrencyCode): number {
  const units = MINOR_UNITS[currency.toUpperCase()];
  if (units === undefined) {
    throw new RangeError(
      `Unknown currency '${currency}'. Add its ISO 4217 minor-unit exponent to financial-core/currency.ts before using it.`,
    );
  }
  return units;
}

export function isKnownCurrency(currency: string): boolean {
  return Object.prototype.hasOwnProperty.call(MINOR_UNITS, currency.toUpperCase());
}

export function knownCurrencies(): readonly CurrencyCode[] {
  return Object.keys(MINOR_UNITS);
}
