import { describe, expect, it } from 'vitest';
import {
  priceAlertObserved,
  priceAlertTriggered,
  watchedRange,
  type PriceAlertLevel,
} from './price-alerts';
import type { PriceRange } from './price-range';

const range = (minBid: string, maxBid: string, minAsk: string, maxAsk: string): PriceRange => ({
  minBid,
  maxBid,
  minAsk,
  maxAsk,
});

/** One tick, expressed as the degenerate range every tick is. */
const at = (bid: string, ask: string): PriceRange => range(bid, bid, ask, ask);

const level = (
  condition: 'ABOVE' | 'BELOW',
  price: string,
  source: 'BID' | 'ASK' | 'MID' = 'BID',
): PriceAlertLevel => ({ condition, price, source });

describe('price alerts', () => {
  it('fires when the watched price reaches the level from below', () => {
    expect(priceAlertTriggered(level('ABOVE', '4600'), at('4601.00', '4601.14'))).toBe(true);
  });

  it('stays quiet while the market is short of the level', () => {
    expect(priceAlertTriggered(level('ABOVE', '4600'), at('4599.99', '4600.13'))).toBe(false);
  });

  /**
   * "Tell me at 4600" is a request about *reaching* 4600, not about exceeding
   * it. A trader who watches the price touch their number and hears nothing
   * concludes the feature is broken, and is right to.
   */
  it('treats the level as reached, not exceeded', () => {
    expect(priceAlertTriggered(level('ABOVE', '4600'), at('4600.00', '4600.14'))).toBe(true);
    expect(priceAlertTriggered(level('BELOW', '4600'), at('4600.00', '4600.14'))).toBe(true);
  });

  it('fires a BELOW when the market falls to the level', () => {
    expect(priceAlertTriggered(level('BELOW', '4500'), at('4499.50', '4499.64'))).toBe(true);
    expect(priceAlertTriggered(level('BELOW', '4500'), at('4500.01', '4500.15'))).toBe(false);
  });

  /**
   * The reason this takes a range at all. A market that jumps from 4590 to 4610
   * has passed 4600, and a trader who asked to be told at 4600 is not helped by
   * silence because no tick printed exactly there.
   */
  it('fires on a level the market gapped straight through', () => {
    expect(
      priceAlertTriggered(level('ABOVE', '4600'), range('4590', '4610', '4590.1', '4610.1')),
    ).toBe(true);
    expect(
      priceAlertTriggered(level('BELOW', '4500'), range('4490', '4510', '4490.1', '4510.1')),
    ).toBe(true);
  });

  it('watches the half of the book it was told to', () => {
    // The ask is above the level; the bid is not.
    const quote = at('4599.90', '4600.10');
    expect(priceAlertTriggered(level('ABOVE', '4600', 'BID'), quote)).toBe(false);
    expect(priceAlertTriggered(level('ABOVE', '4600', 'ASK'), quote)).toBe(true);
  });

  it('derives MID from the extremes of both halves', () => {
    expect(watchedRange('MID', range('100', '110', '102', '112'))).toEqual({
      low: '101',
      high: '111',
    });
  });

  /**
   * The widest mid the window can justify, on purpose. An alert that fires on a
   * spread that briefly gaped is a nuisance; one that misses a move because the
   * mid was averaged away is a trader who did not find out.
   */
  it('does not average a MID away across a window', () => {
    expect(
      priceAlertTriggered(level('ABOVE', '111', 'MID'), range('100', '110', '102', '112')),
    ).toBe(true);
  });

  it('reports the price as it stands, not the extreme that triggered it', () => {
    expect(priceAlertObserved('BID', { bid: '4593.00', ask: '4593.14' })).toBe('4593.00');
    expect(priceAlertObserved('ASK', { bid: '4593.00', ask: '4593.14' })).toBe('4593.14');
    expect(priceAlertObserved('MID', { bid: '100', ask: '102' })).toBe('101');
  });
});
