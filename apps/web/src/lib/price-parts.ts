/**
 * A price split the way a dealing screen prints it.
 *
 * On a quote board the eye wants the digits that move, not the ones that have
 * said "1.08" all week. Desktop dealing screens have long printed the last two
 * whole points large and a fractional pip (the fifth decimal of a five-decimal
 * pair, the third of a three-decimal one) small and raised. This does the
 * splitting; `PriceFigure` does the printing.
 *
 * It works on the string already formatted for the screen, so it can never
 * change what the price says — joined back together, the three parts are the
 * input, character for character.
 */
export interface PriceParts {
  /** Everything before the digits that move: `1.08` of `1.08753`. */
  lead: string;
  /** The two digits that move, with any decimal point between them. */
  big: string;
  /** The fractional pip, printed small; empty where the instrument has none. */
  pipette: string;
}

const DIGIT = /\d/;

export function priceParts(formatted: string, precision: number): PriceParts {
  if (!/\d/.test(formatted)) return { lead: formatted, big: '', pipette: '' };

  // A fractional pip exists only on the odd precisions FX quotes in: five
  // decimals on most pairs, three on yen pairs.
  const hasPipette = (precision === 3 || precision === 5) && DIGIT.test(formatted.at(-1) ?? '');
  const pipette = hasPipette ? formatted.slice(-1) : '';
  const rest = hasPipette ? formatted.slice(0, -1) : formatted;

  // Walk back over two digits, carrying a decimal point that falls between them.
  let digits = 0;
  let index = rest.length;
  while (index > 0 && digits < 2) {
    const char = rest[index - 1]!;
    if (DIGIT.test(char)) digits += 1;
    else if (char !== '.') break;
    index -= 1;
  }
  return { lead: rest.slice(0, index), big: rest.slice(index), pipette };
}
