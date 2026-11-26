import type { ChartLevel } from './chart-html';
import { formatSigned, theme } from './theme';

/** What the chart needs of an open position. */
export interface LevelSource {
  /** The position's id, when known: its lines can then be dragged. */
  readonly id?: string;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly volume: string;
  readonly entryPrice: string;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** The server's mark; `null` when no fresh price exists. */
  readonly floatingPnl: string | null;
}

/**
 * The lines for one instrument's chart, from its open positions: the entry
 * (with what the position is making now), the stop in red and the target in
 * blue, both drawn heavier than the entry so the risk is what the eye finds.
 *
 * Only this instrument's positions — a stop on gold drawn across the euro's
 * chart would be a line at a meaningless price. Every price is the server's,
 * passed through as the string it sent.
 */
export function levelsFor(positions: readonly LevelSource[], symbol: string): ChartLevel[] {
  const levels: ChartLevel[] = [];
  for (const position of positions) {
    if (position.symbol !== symbol) continue;
    const drag = (kind: 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT') =>
      position.id === undefined
        ? {}
        : {
            drag: {
              positionId: position.id,
              kind,
              side: position.side,
              entry: position.entryPrice,
            },
          };
    levels.push({
      ...drag('ENTRY'),
      price: position.entryPrice,
      color: theme.colors.textMuted,
      width: 1,
      dashed: false,
      title:
        position.floatingPnl === null
          ? `${position.side} ${position.volume}`
          : `${position.side} ${position.volume}  ${formatSigned(position.floatingPnl)}`,
    });
    if (position.stopLoss !== null) {
      levels.push({
        ...drag('STOP_LOSS'),
        price: position.stopLoss,
        color: theme.colors.negative,
        width: 2,
        dashed: true,
        title: `SL ${position.stopLoss}`,
      });
    }
    if (position.takeProfit !== null) {
      levels.push({
        ...drag('TAKE_PROFIT'),
        price: position.takeProfit,
        color: theme.colors.profit,
        width: 2,
        dashed: true,
        title: `TP ${position.takeProfit}`,
      });
    }
  }
  return levels;
}
