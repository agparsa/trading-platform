import { describe, expect, it } from 'vitest';
import { OPEN_POSITION_COLUMNS, filterPositions, openPositionRow } from './positions-view';
import type { PositionRow } from './queries';

const base: PositionRow = {
  id: 'f7a1b2c3-0000-4000-8000-000000000001',
  symbol: 'XAUUSD',
  side: 'BUY',
  status: 'OPEN',
  volume: '0.30',
  initialVolume: '0.50',
  entryPrice: '4000.00',
  currentPrice: '4001.00',
  stopLoss: '3988.00',
  takeProfit: null,
  trailingStopDistance: '5.00',
  highWaterPrice: '4001.00',
  margin: '120.00',
  commission: '1.50',
  swap: '-0.75',
  realizedPnl: '0.00',
  closeReason: null,
  openedAt: '2026-09-27T10:00:00.000Z',
  closedAt: null,
};
const gold = base;
const goldShort = { ...base, id: 'a1000000-0000-4000-8000-000000000002', side: 'SELL' as const };
const euro = { ...base, id: 'b2000000-0000-4000-8000-000000000003', symbol: 'EURUSD' };
const refs = new Map([
  [gold.id, 'F7A1'],
  [goldShort.id, 'A100'],
  [euro.id, 'B200'],
]);

describe('filtering the open positions', () => {
  const all = [gold, goldShort, euro];

  it('matches everything on an empty or blank filter', () => {
    expect(filterPositions(all, '')).toHaveLength(3);
    expect(filterPositions(all, '   ')).toHaveLength(3);
  });

  it('matches a symbol by any part of it, a side by the whole word', () => {
    expect(filterPositions(all, 'xau').map((p) => p.id)).toEqual([gold.id, goldShort.id]);
    expect(filterPositions(all, 'usd')).toHaveLength(3);
    expect(filterPositions(all, 'sell').map((p) => p.id)).toEqual([goldShort.id]);
    // "b" is not a side, and does not match BUY by prefix: a filter that
    // matched every long on one letter would surprise the person typing "btc".
    expect(filterPositions(all, 'b', refs).map((p) => p.id)).toEqual([euro.id]);
  });

  it('matches the reference or the id by prefix, case-insensitively', () => {
    expect(filterPositions(all, 'f7', refs).map((p) => p.id)).toEqual([gold.id]);
    expect(filterPositions(all, 'F7A1', refs).map((p) => p.id)).toEqual([gold.id]);
    expect(filterPositions(all, 'a1000000-0000').map((p) => p.id)).toEqual([goldShort.id]);
  });

  it('requires every word: "xau buy" is the longs in gold', () => {
    expect(filterPositions(all, 'xau buy').map((p) => p.id)).toEqual([gold.id]);
    expect(filterPositions(all, 'xau eur')).toEqual([]);
  });

  it('treats the filter as words, not a pattern', () => {
    expect(filterPositions(all, '.*')).toEqual([]);
    expect(filterPositions(all, 'XAU|EUR')).toEqual([]);
  });
});

describe('writing the open positions out', () => {
  it('writes the server’s own decimals, the mark at export, and blanks for absent levels', () => {
    const row = openPositionRow(gold, {
      currentPrice: '4002.50',
      floatingPnl: '75.00',
      netPnl: '72.75',
    });
    expect(row).toHaveLength(OPEN_POSITION_COLUMNS.length);
    const named = Object.fromEntries(OPEN_POSITION_COLUMNS.map((column, i) => [column, row[i]]));
    expect(named).toMatchObject({
      positionId: gold.id,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.30',
      initialVolume: '0.50',
      entryPrice: '4000.00',
      currentPrice: '4002.50',
      stopLoss: '3988.00',
      takeProfit: '',
      trailingStopDistance: '5.00',
      margin: '120.00',
      floatingPnlAtExport: '75.00',
      netPnlAtExport: '72.75',
    });
  });

  it('falls back to the row’s own price when there is no mark, and leaves P&L blank', () => {
    const row = openPositionRow(gold, { currentPrice: null, floatingPnl: null, netPnl: null });
    const named = Object.fromEntries(OPEN_POSITION_COLUMNS.map((column, i) => [column, row[i]]));
    expect(named['currentPrice']).toBe('4001.00');
    expect(named['floatingPnlAtExport']).toBe('');
    expect(named['netPnlAtExport']).toBe('');
  });
});
