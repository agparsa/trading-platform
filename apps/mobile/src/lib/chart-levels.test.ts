import { describe, expect, it } from 'vitest';
import { levelsFor, type LevelSource } from './chart-levels';
import { setLevelsScript } from './chart-html';
import { theme } from './theme';

const gold: LevelSource = {
  symbol: 'XAUUSD',
  side: 'BUY',
  volume: '0.10',
  entryPrice: '2000.00',
  stopLoss: '1995.00',
  takeProfit: '2010.00',
  floatingPnl: '12.30',
};

describe('the position lines on a chart', () => {
  it('lets a position’s lines be dragged, each saying what a drag may change', () => {
    const levels = levelsFor([{ ...gold, id: 'p1' }], 'XAUUSD');
    expect(levels.map((level) => level.drag?.kind)).toEqual(['ENTRY', 'STOP_LOSS', 'TAKE_PROFIT']);
    expect(levels[0]?.drag).toEqual({
      positionId: 'p1',
      kind: 'ENTRY',
      side: 'BUY',
      entry: '2000.00',
    });
  });

  it('draws the entry, a red stop and a blue target, the levels heavier', () => {
    expect(levelsFor([gold], 'XAUUSD')).toEqual([
      {
        price: '2000.00',
        color: theme.colors.textMuted,
        width: 1,
        dashed: false,
        title: 'BUY 0.10  +12.30',
      },
      {
        price: '1995.00',
        color: theme.colors.negative,
        width: 2,
        dashed: true,
        title: 'SL 1995.00',
      },
      { price: '2010.00', color: theme.colors.profit, width: 2, dashed: true, title: 'TP 2010.00' },
    ]);
  });

  it('draws only the levels a position has, and no P&L it does not know', () => {
    const bare = { ...gold, stopLoss: null, takeProfit: null, floatingPnl: null };
    expect(levelsFor([bare], 'XAUUSD')).toEqual([
      {
        price: '2000.00',
        color: theme.colors.textMuted,
        width: 1,
        dashed: false,
        title: 'BUY 0.10',
      },
    ]);
  });

  it('leaves another instrument’s positions off this chart', () => {
    expect(levelsFor([gold], 'EURUSD')).toEqual([]);
  });

  it('is injected as script-safe JSON', () => {
    const script = setLevelsScript([{ ...levelsFor([gold], 'XAUUSD')[0]!, title: '</script>' }]);
    expect(script).not.toContain('</script>');
    expect(script.startsWith('window.__setLevels(')).toBe(true);
  });
});
