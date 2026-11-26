import { describe, expect, it } from 'vitest';
import { priceFromPoints } from './level-points';

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
