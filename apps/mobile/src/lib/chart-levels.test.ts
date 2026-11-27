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

  it('draws the entry in its side’s colour, a red stop and a blue target, each tagged', () => {
    expect(levelsFor([gold], 'XAUUSD')).toEqual([
      {
        price: '2000.00',
        color: theme.colors.positive,
        width: 1,
        dashed: false,
        title: 'BUY 0.10  +12.30',
        tag: { text: 'BUY 0.10 · 2000.00  +12.30', tone: 'buy' },
      },
      {
        price: '1995.00',
        color: theme.colors.negative,
        width: 2,
        dashed: true,
        title: 'SL 1995.00',
        tag: { text: 'SL 1995.00', tone: 'sl' },
      },
      {
        price: '2010.00',
        color: theme.colors.profit,
        width: 2,
        dashed: true,
        title: 'TP 2010.00',
        tag: { text: 'TP 2010.00', tone: 'tp' },
      },
    ]);
  });

  it('draws only the levels a position has, and no P&L it does not know', () => {
    const bare = { ...gold, stopLoss: null, takeProfit: null, floatingPnl: null };
    expect(levelsFor([bare], 'XAUUSD').map((level) => level.tag?.text)).toEqual([
      'BUY 0.10 · 2000.00',
    ]);
  });

  it('numbers several trades on one chart, oldest first, each line at its own exact price', () => {
    const later = {
      ...gold,
      id: 'p2',
      side: 'SELL' as const,
      entryPrice: '2000.40',
      stopLoss: '2004.00',
      takeProfit: null,
      floatingPnl: '-1.10',
      openedAt: '2026-11-27T10:05:00Z',
    };
    const first = { ...gold, id: 'p1', openedAt: '2026-11-27T10:00:00Z' };
    const levels = levelsFor([later, first], 'XAUUSD');
    expect(levels.map((level) => [level.price, level.tag?.text])).toEqual([
      ['2000.00', '#1 BUY 0.10 · 2000.00  +12.30'],
      ['1995.00', '#1 SL 1995.00'],
      ['2010.00', '#1 TP 2010.00'],
      ['2000.40', '#2 SELL 0.10 · 2000.40  -1.10'],
      ['2004.00', '#2 SL 2004.00'],
    ]);
    expect(levels[3]?.drag?.positionId).toBe('p2');
    expect(levels[3]?.color).toBe(theme.colors.negative);
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
