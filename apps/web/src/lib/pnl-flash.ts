import { toDecimal } from '@tp/financial-core';

/**
 * Which way a money figure just moved, for the flash behind it.
 *
 * Compared as decimals, never as numbers: two P&L strings that differ in the
 * last cent are a move, and `Number()` on a large figure can lose exactly
 * that cent. Nothing to say when either side is unknown or unparseable — a
 * figure appearing for the first time has not moved, and a flash on the
 * first frame would announce a change that never happened.
 */
export function flashDirection(
  before: string | null | undefined,
  after: string | null | undefined,
): 'profit' | 'loss' | null {
  if (before == null || after == null || before === after) return null;
  try {
    const cmp = toDecimal(after).cmp(toDecimal(before));
    return cmp > 0 ? 'profit' : cmp < 0 ? 'loss' : null;
  } catch {
    return null;
  }
}
