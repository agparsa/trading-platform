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
      return 'bg-amber-500/15 text-amber-300 ring-amber-500/30';
    case InstrumentKind.CRYPTO:
      return 'bg-violet-500/15 text-violet-300 ring-violet-500/30';
    case InstrumentKind.FX:
      return 'bg-sky-500/15 text-sky-300 ring-sky-500/30';
    default:
      return 'bg-terminal-panel text-terminal-muted ring-white/10';
  }
}
