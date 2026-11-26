/**
 * How an instrument is marked in a list: its family and a short glyph on a
 * coloured disc — a currency pair by its base currency's sign, a metal by its
 * chemical symbol, a coin by its own sign. A list of six-letter codes is a
 * list a trader has to read; a column of marks is one they can scan.
 *
 * Derived from the code alone, so an instrument added tomorrow is marked too,
 * if plainly; nothing here decides what can be traded.
 */
export type InstrumentFamily = 'fx' | 'metal' | 'crypto' | 'other';

export interface InstrumentMark {
  readonly family: InstrumentFamily;
  readonly glyph: string;
  readonly color: string;
  /** A pair's two currencies as flags, base first — drawn as two discs. */
  readonly flags?: readonly [string, string];
}

/** A currency's flag, as the emoji every phone already draws in colour. */
const FLAGS: Readonly<Record<string, string>> = {
  EUR: '🇪🇺',
  USD: '🇺🇸',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  AUD: '🇦🇺',
  NZD: '🇳🇿',
  CAD: '🇨🇦',
  CHF: '🇨🇭',
};

const METALS: Readonly<Record<string, { glyph: string; color: string }>> = {
  XAU: { glyph: 'Au', color: '#D4A72C' },
  XAG: { glyph: 'Ag', color: '#9AA4B2' },
  XPT: { glyph: 'Pt', color: '#7FA6C9' },
  XPD: { glyph: 'Pd', color: '#B08FCF' },
};

const COINS: Readonly<Record<string, { glyph: string; color: string }>> = {
  BTC: { glyph: '₿', color: '#F7931A' },
  ETH: { glyph: 'Ξ', color: '#7C8CF8' },
  SOL: { glyph: 'S', color: '#14F195' },
  XRP: { glyph: 'X', color: '#3A8DDE' },
};

const CURRENCIES: Readonly<Record<string, { glyph: string; color: string }>> = {
  EUR: { glyph: '€', color: '#3B82F6' },
  GBP: { glyph: '£', color: '#8B5CF6' },
  USD: { glyph: '$', color: '#16A34A' },
  JPY: { glyph: '¥', color: '#E11D48' },
  AUD: { glyph: 'A$', color: '#0EA5E9' },
  NZD: { glyph: 'N$', color: '#14B8A6' },
  CAD: { glyph: 'C$', color: '#DC2626' },
  CHF: { glyph: 'Fr', color: '#EF4444' },
};

export function instrumentMark(code: string): InstrumentMark {
  const upper = code.toUpperCase();
  const base = upper.slice(0, 3);
  const metal = METALS[base];
  if (metal !== undefined) return { family: 'metal', ...metal };
  const coin = COINS[base];
  if (coin !== undefined) return { family: 'crypto', ...coin };
  const currency = CURRENCIES[base];
  const quote = upper.slice(3, 6);
  if (currency !== undefined && CURRENCIES[quote] !== undefined) {
    const baseFlag = FLAGS[base];
    const quoteFlag = FLAGS[quote];
    return {
      family: 'fx',
      ...currency,
      ...(baseFlag === undefined || quoteFlag === undefined
        ? {}
        : { flags: [baseFlag, quoteFlag] as const }),
    };
  }
  return { family: 'other', glyph: upper.slice(0, 2), color: '#64748B' };
}
