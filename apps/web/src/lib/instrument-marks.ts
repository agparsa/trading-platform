/**
 * What an instrument looks like at a glance, and what its prices are counted in.
 *
 * A watchlist of eight six-letter codes in the same weight is a wall of text: a
 * trader scanning for gold reads XAUUSD, XAGUSD and AUDUSD as the same shape.
 * This gives each one a mark and a colour that survive peripheral vision.
 *
 * Derived from the code and the quote currency, both of which are already on the
 * wire. Category exists in the database and is deliberately not used here —
 * pushing presentation metadata through `SymbolSpec`, which the margin and P&L
 * engines read on every order, would be a poor trade for an icon.
 *
 * No image files. A glyph renders at any size, in any theme, with no request,
 * no missing-asset placeholder and nothing to keep in sync with the instrument
 * list.
 */

export const InstrumentKind = {
  METAL: 'METAL',
  CRYPTO: 'CRYPTO',
  FX: 'FX',
  OTHER: 'OTHER',
} as const;
export type InstrumentKind = (typeof InstrumentKind)[keyof typeof InstrumentKind];

export interface InstrumentMark {
  /** One or two characters. Renders in a badge. */
  readonly glyph: string;
  readonly kind: InstrumentKind;
  /** Spoken form, for a screen reader and a tooltip. */
  readonly label: string;
}

/**
 * The metals carry their element symbols, which is what XAU and XAG are: the
 * X marks a commodity under ISO 4217 and the rest is the periodic table.
 */
const METALS: Readonly<Record<string, { glyph: string; label: string }>> = {
  XAU: { glyph: 'Au', label: 'Gold' },
  XAG: { glyph: 'Ag', label: 'Silver' },
  XPT: { glyph: 'Pt', label: 'Platinum' },
  XPD: { glyph: 'Pd', label: 'Palladium' },
};

const CRYPTO: Readonly<Record<string, { glyph: string; label: string }>> = {
  BTC: { glyph: '₿', label: 'Bitcoin' },
  ETH: { glyph: 'Ξ', label: 'Ether' },
  LTC: { glyph: 'Ł', label: 'Litecoin' },
  XRP: { glyph: '✕', label: 'XRP' },
  SOL: { glyph: '◎', label: 'Solana' },
  ADA: { glyph: '₳', label: 'Cardano' },
  DOGE: { glyph: 'Ð', label: 'Dogecoin' },
};

/**
 * Currency symbols, for prices and for the FX marks.
 *
 * Several currencies share `$`, which is why the ambiguous ones keep their
 * letter: a trader holding an Australian account should never have to work out
 * which dollar a bare `$` meant.
 */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  CHF: '₣',
  AUD: 'A$',
  CAD: 'C$',
  NZD: 'N$',
  SEK: 'kr',
  NOK: 'kr',
  TRY: '₺',
  RUB: '₽',
  INR: '₹',
  KRW: '₩',
  IRR: '﷼',
};

/**
 * The symbol a price in this currency is counted in, or the code itself.
 *
 * Falling back to the code rather than to `$` matters: a wrong currency symbol
 * on a balance is worse than no symbol at all, because it is not obviously
 * missing.
 */
export function currencySymbol(currency: string): string {
  const code = currency.trim().toUpperCase();
  return CURRENCY_SYMBOLS[code] ?? code;
}

/** Is this a currency the platform knows a symbol for? */
export function hasCurrencySymbol(currency: string): boolean {
  return CURRENCY_SYMBOLS[currency.trim().toUpperCase()] !== undefined;
}

/**
 * The mark for an instrument code.
 *
 * A six-character code is read as two three-character currencies, which is the
 * ISO 4217 pair convention every one of these follows — XAUUSD is XAU against
 * USD, EURUSD is EUR against USD. Anything that does not fit that shape gets
 * its first two characters rather than nothing, because a blank badge in a
 * list of full ones reads as a loading state.
 */
export function markFor(code: string): InstrumentMark {
  const upper = code.trim().toUpperCase();
  const base = upper.slice(0, 3);
  const quote = upper.length === 6 ? upper.slice(3, 6) : '';

  const metal = METALS[base];
  if (metal !== undefined) {
    return { glyph: metal.glyph, kind: InstrumentKind.METAL, label: metal.label };
  }

  const crypto = CRYPTO[base];
  if (crypto !== undefined) {
    return { glyph: crypto.glyph, kind: InstrumentKind.CRYPTO, label: crypto.label };
  }

  if (quote.length === 3 && hasCurrencySymbol(base) && hasCurrencySymbol(quote)) {
    // Both halves are currencies the platform can name: show the pair.
    return {
      glyph: currencySymbol(base).slice(0, 1) + currencySymbol(quote).slice(0, 1),
      kind: InstrumentKind.FX,
      label: `${base} against ${quote}`,
    };
  }

  return { glyph: upper.slice(0, 2) || '—', kind: InstrumentKind.OTHER, label: upper };
}

/**
 * Tailwind classes for a kind's badge.
 *
 * Colour carries the class, not the instrument: gold and silver share a tone
 * because at a glance the useful distinction is "metal, not crypto". The glyph
 * separates them once the eye has landed.
 */
export function markClasses(kind: InstrumentKind): string {
  switch (kind) {
    case InstrumentKind.METAL:
      return 'bg-amber-500/15 text-amber-300 ring-amber-500/30 light:text-amber-800 light:ring-amber-600/40';
    case InstrumentKind.CRYPTO:
      return 'bg-violet-500/15 text-violet-300 ring-violet-500/30 light:text-violet-800 light:ring-violet-600/40';
    case InstrumentKind.FX:
      return 'bg-sky-500/15 text-sky-300 ring-sky-500/30 light:text-sky-800 light:ring-sky-600/40';
    default:
      return 'bg-terminal-raised text-terminal-muted ring-white/10 light:ring-black/10';
  }
}

/** One disc of an instrument's icon: a symbol on a colour. */
export interface IconDisc {
  readonly glyph: string;
  /** Fill, as a hex colour; the glyph is drawn in white over it. */
  readonly fill: string;
}

/**
 * Each currency's disc colour. Chosen to tell the majors apart at 16 pixels
 * — not flags, which become noise at that size, and not anybody's logo.
 */
const DISC_COLOURS: Readonly<Record<string, string>> = {
  USD: '#2f9e6b',
  EUR: '#2f5fbf',
  GBP: '#7a3fb8',
  JPY: '#c8373f',
  CHF: '#d0452f',
  AUD: '#d9851e',
  CAD: '#b8323a',
  NZD: '#2a7f8a',
  CNY: '#c23b2f',
  XAU: '#c99a2e',
  XAG: '#8a96a3',
  XPT: '#7d8a99',
  XPD: '#6f7c8c',
  BTC: '#e8891a',
  ETH: '#5b67c9',
  LTC: '#4d6fa8',
  XRP: '#3a4250',
  SOL: '#8a4fd8',
  ADA: '#2a5fbf',
  DOGE: '#b8962e',
};

/**
 * The discs an instrument's icon is drawn from: one for a metal or a coin,
 * two overlapping — base in front, quote behind — for a currency pair, the
 * way a trading app's market list shows them.
 */
export function iconFor(code: string): readonly IconDisc[] {
  const upper = code.trim().toUpperCase();
  const base = upper.slice(0, 3);
  const quote = upper.length === 6 ? upper.slice(3, 6) : '';
  const metal = METALS[base];
  if (metal !== undefined) return [{ glyph: metal.glyph, fill: DISC_COLOURS[base] ?? '#8a96a3' }];
  const coin = CRYPTO[base] ?? CRYPTO[upper.replace(/USDT?$/, '')];
  if (coin !== undefined) {
    const key = CRYPTO[base] !== undefined ? base : upper.replace(/USDT?$/, '');
    return [{ glyph: coin.glyph, fill: DISC_COLOURS[key] ?? '#6b5bd6' }];
  }
  if (quote.length === 3 && hasCurrencySymbol(base) && hasCurrencySymbol(quote)) {
    const disc = (currency: string): IconDisc => ({
      glyph: CURRENCY_SYMBOLS[currency] === undefined ? currency[0]! : currencySymbol(currency),
      fill: DISC_COLOURS[currency] ?? '#5a6472',
    });
    return [disc(base), disc(quote)];
  }
  return [{ glyph: upper.slice(0, 2) || '—', fill: '#5a6472' }];
}
