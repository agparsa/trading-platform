import { describe, expect, it } from 'vitest';
import { DomainError } from '@tp/shared-types';
import { XAUUSD } from './__fixtures__/instruments';
import {
  isExpired,
  shouldTriggerPending,
  validatePendingPrice,
  waitsForFall,
} from './pending-orders';

/**
 * Resting orders.
 *
 * Every combination of type and side is asserted, because the four cases are
 * two independent inversions and a plausible-looking implementation can get
 * exactly one of them backwards — which turns a limit order into a market order
 * at the worst moment and does so silently.
 */

const quote = { bid: '2000.00', ask: '2000.20' };

describe('waitsForFall', () => {
  it('knows which direction each of the four orders is waiting for', () => {
    expect(waitsForFall('LIMIT', 'BUY')).toBe(true); // buy cheaper
    expect(waitsForFall('LIMIT', 'SELL')).toBe(false); // sell dearer
    expect(waitsForFall('STOP', 'BUY')).toBe(false); // buy a breakout
    expect(waitsForFall('STOP', 'SELL')).toBe(true); // sell a breakdown
  });
});

describe('shouldTriggerPending', () => {
  /** A buy is measured against the ask — the price the trader would actually pay. */
  it('measures a buy against the ask', () => {
    // Ask 2000.20. A buy limit at 2000.10 is not reached even though the bid is
    // below it, because nobody can buy at the bid.
    expect(shouldTriggerPending('LIMIT', 'BUY', '2000.10', quote)).toBe(false);
    expect(shouldTriggerPending('LIMIT', 'BUY', '2000.20', quote)).toBe(true);
  });

  it('measures a sell against the bid', () => {
    // Bid 2000.00. A sell limit at 2000.10 is not reached even though the ask
    // is above it.
    expect(shouldTriggerPending('LIMIT', 'SELL', '2000.10', quote)).toBe(false);
    expect(shouldTriggerPending('LIMIT', 'SELL', '2000.00', quote)).toBe(true);
  });

  it('fires a buy limit when the ask falls to it', () => {
    expect(shouldTriggerPending('LIMIT', 'BUY', '1990.00', quote)).toBe(false);
    expect(
      shouldTriggerPending('LIMIT', 'BUY', '1990.00', { bid: '1989.80', ask: '1990.00' }),
    ).toBe(true);
  });

  it('fires a sell limit when the bid rises to it', () => {
    expect(shouldTriggerPending('LIMIT', 'SELL', '2010.00', quote)).toBe(false);
    expect(
      shouldTriggerPending('LIMIT', 'SELL', '2010.00', { bid: '2010.00', ask: '2010.20' }),
    ).toBe(true);
  });

  it('fires a buy stop when the ask rises to it', () => {
    expect(shouldTriggerPending('STOP', 'BUY', '2010.00', quote)).toBe(false);
    expect(shouldTriggerPending('STOP', 'BUY', '2010.00', { bid: '2009.80', ask: '2010.00' })).toBe(
      true,
    );
  });

  it('fires a sell stop when the bid falls to it', () => {
    expect(shouldTriggerPending('STOP', 'SELL', '1990.00', quote)).toBe(false);
    expect(
      shouldTriggerPending('STOP', 'SELL', '1990.00', { bid: '1990.00', ask: '1990.20' }),
    ).toBe(true);
  });

  /**
   * Inclusive on purpose. An order resting exactly at the printed price has been
   * reached; requiring the market to trade through it would leave orders
   * unfilled at a price the market actually showed.
   */
  it('treats an exact touch as reached, for all four', () => {
    expect(shouldTriggerPending('LIMIT', 'BUY', '2000.20', quote)).toBe(true);
    expect(shouldTriggerPending('LIMIT', 'SELL', '2000.00', quote)).toBe(true);
    expect(shouldTriggerPending('STOP', 'BUY', '2000.20', quote)).toBe(true);
    expect(shouldTriggerPending('STOP', 'SELL', '2000.00', quote)).toBe(true);
  });
});

describe('validatePendingPrice', () => {
  const check = (type: 'LIMIT' | 'STOP', side: 'BUY' | 'SELL', price: string) => () =>
    validatePendingPrice(XAUUSD, type, side, price, quote);

  it('accepts each of the four resting on its correct side', () => {
    expect(check('LIMIT', 'BUY', '1990.00')).not.toThrow();
    expect(check('LIMIT', 'SELL', '2010.00')).not.toThrow();
    expect(check('STOP', 'BUY', '2010.00')).not.toThrow();
    expect(check('STOP', 'SELL', '1990.00')).not.toThrow();
  });

  /**
   * The rule that matters. An order placed on the wrong side fires on the very
   * next tick — the trader gets a market order at a price they never chose.
   */
  it('refuses an order that would fill immediately', () => {
    expect(check('LIMIT', 'BUY', '2010.00')).toThrow(DomainError);
    expect(check('LIMIT', 'SELL', '1990.00')).toThrow(DomainError);
    expect(check('STOP', 'BUY', '1990.00')).toThrow(DomainError);
    expect(check('STOP', 'SELL', '2010.00')).toThrow(DomainError);
  });

  it('says which side the price should have been on, and suggests a market order', () => {
    expect(check('LIMIT', 'BUY', '2010.00')).toThrow(/must rest below/);
    expect(check('STOP', 'BUY', '1990.00')).toThrow(/must rest above/);
    expect(check('LIMIT', 'BUY', '2010.00')).toThrow(/market order/);
  });

  it('rejects a price off the tick grid', () => {
    expect(check('LIMIT', 'BUY', '1990.005')).toThrow(/tick size/);
  });

  it('rejects a non-positive price', () => {
    expect(check('LIMIT', 'BUY', '0')).toThrow(/positive/);
  });
});

describe('isExpired', () => {
  it('never expires an order with no expiry', () => {
    expect(isExpired({ timeInForce: 'GTC', expiresAt: null }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('expires once the moment is reached', () => {
    const order = { timeInForce: 'GTD', expiresAt: 1_700_000_000_000 };
    expect(isExpired(order, 1_699_999_999_999)).toBe(false);
    expect(isExpired(order, 1_700_000_000_000)).toBe(true);
    expect(isExpired(order, 1_700_000_000_001)).toBe(true);
  });
});
