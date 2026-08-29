import { describe, expect, it } from 'vitest';
import { distanceInPoints, triggerSide } from './points';

describe('distanceInPoints', () => {
  it('counts a five-decimal FX move in points', () => {
    expect(distanceInPoints('1.08750', '1.08630', 5)).toBe(120);
  });

  it('counts a two-decimal metal move in points', () => {
    expect(distanceInPoints('4583.58', '4580.08', 2)).toBe(350);
  });

  it('is unsigned — a resting order above or below is the same distance away', () => {
    expect(distanceInPoints('1.08750', '1.08630', 5)).toBe(
      distanceInPoints('1.08510', '1.08630', 5),
    );
  });

  it('says nothing rather than guessing when there is no quote', () => {
    expect(distanceInPoints('1.08750', null, 5)).toBeNull();
    expect(distanceInPoints('1.08750', undefined, 5)).toBeNull();
  });

  it('says nothing rather than showing NaN for an unparseable figure', () => {
    expect(distanceInPoints('not-a-price', '1.08630', 5)).toBeNull();
    expect(distanceInPoints('1.08750', 'nonsense', 5)).toBeNull();
  });

  it('refuses a precision that would produce a meaningless number', () => {
    expect(distanceInPoints('1.08750', '1.08630', -1)).toBeNull();
    expect(distanceInPoints('1.08750', '1.08630', 1.5)).toBeNull();
    expect(distanceInPoints('1.08750', '1.08630', 400)).toBeNull();
  });

  it('reads zero when the market is exactly at the trigger', () => {
    expect(distanceInPoints('1.08750', '1.08750', 5)).toBe(0);
  });
});

describe('triggerSide', () => {
  /**
   * The half-spread question. On a wide book, quoting the distance against the
   * mid tells a trader an order is further away than it is.
   */
  it('measures a buy against the ask and a sell against the bid', () => {
    const quote = { bid: '4583.58', ask: '4583.72' };
    expect(triggerSide('BUY', quote)).toBe('4583.72');
    expect(triggerSide('SELL', quote)).toBe('4583.58');
  });

  it('has nothing to offer before the first quote arrives', () => {
    expect(triggerSide('BUY', undefined)).toBeNull();
  });
});
