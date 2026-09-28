import type { PositionRow } from './queries';

/**
 * The open-positions table, narrowed and written out.
 *
 * Both are pure so they can be tested without a table: what a filter matches
 * decides which rows a trader sees and which rows leave in a file, and a
 * filter that matched a side when it meant a symbol would hide positions
 * from the one screen that lists them.
 */

/**
 * Rows matching a typed filter. Each whitespace-separated word must match
 * the symbol, the side, or the start of the position's reference or id,
 * case-insensitively; all words must match. Empty matches everything.
 *
 * "XAU BUY" is the longs in gold; "SELL" is every short; "f7" is the row
 * whose reference starts with it. Words, not a regex: what a trader types
 * into a filter is a name, and `.` in a symbol is a dot.
 */
export function filterPositions<T extends Pick<PositionRow, 'id' | 'symbol' | 'side'>>(
  positions: readonly T[],
  query: string,
  refs: ReadonlyMap<string, string> = new Map(),
): T[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return [...positions];
  return positions.filter((position) => {
    const symbol = position.symbol.toLowerCase();
    const side = position.side.toLowerCase();
    const ref = (refs.get(position.id) ?? '').toLowerCase();
    const id = position.id.toLowerCase();
    return words.every(
      (word) =>
        symbol.includes(word) || side === word || ref.startsWith(word) || id.startsWith(word),
    );
  });
}

/** What the live socket or the REST snapshot says about a position right now. */
export interface PositionMark {
  readonly currentPrice: string | null;
  readonly floatingPnl: string | null;
  readonly netPnl: string | null;
}

/**
 * The file's columns. Every value the server's own decimal string,
 * unformatted: the table rounds for display, and a file somebody reconciles
 * against their own records must not. P&L is the mark at export time and
 * says so in the column name.
 */
export const OPEN_POSITION_COLUMNS = [
  'positionId',
  'openedAt',
  'symbol',
  'side',
  'volume',
  'initialVolume',
  'entryPrice',
  'currentPrice',
  'stopLoss',
  'takeProfit',
  'trailingStopDistance',
  'highWaterPrice',
  'margin',
  'commission',
  'swap',
  'floatingPnlAtExport',
  'netPnlAtExport',
] as const;

export function openPositionRow(position: PositionRow, mark: PositionMark): readonly string[] {
  return [
    position.id,
    position.openedAt,
    position.symbol,
    position.side,
    position.volume,
    position.initialVolume,
    position.entryPrice,
    mark.currentPrice ?? position.currentPrice ?? '',
    position.stopLoss ?? '',
    position.takeProfit ?? '',
    position.trailingStopDistance ?? '',
    position.highWaterPrice ?? '',
    position.margin,
    position.commission,
    position.swap,
    mark.floatingPnl ?? '',
    mark.netPnl ?? '',
  ];
}
