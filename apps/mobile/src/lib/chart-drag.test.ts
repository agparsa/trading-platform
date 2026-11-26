import { describe, expect, it } from 'vitest';
import { dragPatch, kindFromEntry } from './chart-drag';

describe('dragging from a position’s entry line', () => {
  it('sets a buy’s stop below and target above', () => {
    expect(kindFromEntry('BUY', '2000.00', '1995.50')).toBe('STOP_LOSS');
    expect(kindFromEntry('BUY', '2000.00', '2010')).toBe('TAKE_PROFIT');
  });

  it('sets a sell’s stop above and target below', () => {
    expect(kindFromEntry('SELL', '1.08500', '1.08700')).toBe('STOP_LOSS');
    expect(kindFromEntry('SELL', '1.08500', '1.08')).toBe('TAKE_PROFIT');
  });

  it('sets nothing for a drop on the entry, or a price that is not one', () => {
    expect(kindFromEntry('BUY', '2000.00', '2000')).toBeNull();
    expect(kindFromEntry('BUY', '2000.00', 'NaN')).toBeNull();
  });

  it('compares across different widths exactly', () => {
    expect(kindFromEntry('BUY', '999.99', '1000.00')).toBe('TAKE_PROFIT');
    expect(kindFromEntry('BUY', '1000.00', '999.99')).toBe('STOP_LOSS');
  });
});

describe('what a drop sends', () => {
  it('sends only the level that moved', () => {
    expect(dragPatch({ positionId: 'p', kind: 'STOP_LOSS', price: '1995.50' })).toEqual({
      stopLoss: '1995.50',
    });
    expect(dragPatch({ positionId: 'p', kind: 'TAKE_PROFIT', price: '2010.00' })).toEqual({
      takeProfit: '2010.00',
    });
  });
});
