import { describe, expect, it } from 'vitest';
import { priceFromPoints, stepLots } from './level-points';

describe('a level typed in points', () => {
  it('puts a buy’s stop below and target above, a sell’s the other way', () => {
    expect(priceFromPoints('500', '2000.00', 2, 'BUY', 'STOP_LOSS')).toBe('1995.00');
    expect(priceFromPoints('1000', '2000.00', 2, 'BUY', 'TAKE_PROFIT')).toBe('2010.00');
    expect(priceFromPoints('500', '1.08500', 5, 'SELL', 'STOP_LOSS')).toBe('1.09000');
    expect(priceFromPoints('500', '1.08500', 5, 'SELL', 'TAKE_PROFIT')).toBe('1.08000');
  });

  it('says nothing rather than a wrong price', () => {
    expect(priceFromPoints('', '2000.00', 2, 'BUY', 'STOP_LOSS')).toBeNull();
    expect(priceFromPoints('5.5', '2000.00', 2, 'BUY', 'STOP_LOSS')).toBeNull();
    expect(priceFromPoints('0', '2000.00', 2, 'BUY', 'STOP_LOSS')).toBeNull();
    expect(priceFromPoints('500', null, 2, 'BUY', 'STOP_LOSS')).toBeNull();
    // A stop further than the price itself.
    expect(priceFromPoints('300000', '2000.00', 2, 'BUY', 'STOP_LOSS')).toBeNull();
  });
});

describe('stepping lots on the grid', () => {
  const grid = { step: '0.01', min: '0.01' };
  it('steps up and down, never below the minimum', () => {
    expect(stepLots('0.10', grid, 1)).toBe('0.11');
    expect(stepLots('0.10', grid, -1)).toBe('0.09');
    expect(stepLots('0.01', grid, -1)).toBe('0.01');
  });
  it('snaps a value off the grid, and starts a half-typed one from the minimum', () => {
    expect(stepLots('0.104', grid, 1)).toBe('0.11');
    expect(stepLots('', grid, 1)).toBe('0.02');
    expect(stepLots('1.', grid, 1)).toBe('0.02');
  });
  it('leaves the value alone until the grid is known', () => {
    expect(stepLots('0.10', null, 1)).toBe('0.10');
  });
});
