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
  /** When it opened — numbers several positions on one chart oldest first. */
  readonly openedAt?: string;
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
  // Several trades on one instrument are told apart by number, oldest #1, and
  // each one's stop and target carry the same number as its entry.
  const here = positions
    .filter((position) => position.symbol === symbol)
    .slice()
    .sort((a, b) => (a.openedAt ?? '').localeCompare(b.openedAt ?? ''));
  const numbered = here.length > 1;
  here.forEach((position, index) => {
    const n = numbered ? `#${index + 1} ` : '';
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
    const pnl = position.floatingPnl === null ? '' : `  ${formatSigned(position.floatingPnl)}`;
    levels.push({
      ...drag('ENTRY'),
      price: position.entryPrice,
      color: position.side === 'BUY' ? theme.colors.positive : theme.colors.negative,
      width: 1,
      dashed: false,
      title: `${n}${position.side} ${position.volume}${pnl}`,
      tag: {
        text: `${n}${position.side} ${position.volume} · ${position.entryPrice}${pnl}`,
        tone: position.side === 'BUY' ? 'buy' : 'sell',
      },
    });
    if (position.stopLoss !== null) {
      levels.push({
        ...drag('STOP_LOSS'),
        price: position.stopLoss,
        color: theme.colors.negative,
        width: 2,
        dashed: true,
        title: `${n}SL ${position.stopLoss}`,
        tag: { text: `${n}SL ${position.stopLoss}`, tone: 'sl' },
      });
    }
    if (position.takeProfit !== null) {
      levels.push({
        ...drag('TAKE_PROFIT'),
        price: position.takeProfit,
        color: theme.colors.profit,
        width: 2,
        dashed: true,
        title: `${n}TP ${position.takeProfit}`,
        tag: { text: `${n}TP ${position.takeProfit}`, tone: 'tp' },
      });
    }
  });
  return levels;
}
