import { describe, expect, it } from 'vitest';
import { DomainError } from '@tp/shared-types';
import { XAUUSD } from './__fixtures__/instruments';
import {
  activeLeg,
  isExpired,
  shouldTriggerPending,
  validatePendingPrice,
  validateStopLimit,
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

describe('stop-limit', () => {
  const order = (activated: boolean) => ({
    type: 'STOP_LIMIT',
    price: '2012.00',
    stopPrice: '2010.00',
    activated,
  });

  /**
   * The whole engine rests on this: before its stop is reached a stop-limit is
   * a stop on the stop price, after it a limit on the limit price. Getting the
   * phase or the price wrong turns it into a stop (a market order at the
   * stop) or into a limit resting on the wrong side.
   */
  it('waits as a stop on its stop price, then as a limit on its limit price', () => {
    expect(activeLeg(order(false))).toEqual({ type: 'STOP', price: '2010.00' });
    expect(activeLeg(order(true))).toEqual({ type: 'LIMIT', price: '2012.00' });
  });

  it('leaves limits and stops as they were, and works nothing else', () => {
    expect(
      activeLeg({ type: 'LIMIT', price: '1990.00', stopPrice: null, activated: false }),
    ).toEqual({ type: 'LIMIT', price: '1990.00' });
    // A plain stop stores its price in both columns; the resting price is the one used.
    expect(
      activeLeg({ type: 'STOP', price: '2010.00', stopPrice: '2010.00', activated: false }),
    ).toEqual({ type: 'STOP', price: '2010.00' });
    expect(
      activeLeg({ type: 'MARKET', price: null, stopPrice: null, activated: false }),
    ).toBeNull();
    expect(activeLeg({ ...order(false), stopPrice: null })).toBeNull();
    expect(activeLeg({ ...order(true), price: null })).toBeNull();
  });

  const check = (side: 'BUY' | 'SELL', stop: string, limit: string) => () =>
    validateStopLimit(XAUUSD, side, stop, limit, quote);

  it('accepts a stop on the far side, with the limit either side of it', () => {
    // A buy breakout capped above the stop, and one waiting for the pull-back.
    expect(check('BUY', '2010.00', '2012.00')).not.toThrow();
    expect(check('BUY', '2010.00', '2005.00')).not.toThrow();
    expect(check('SELL', '1990.00', '1988.00')).not.toThrow();
    expect(check('SELL', '1990.00', '1995.00')).not.toThrow();
  });

  it('refuses a stop the market has already reached, and says what to place instead', () => {
    expect(check('BUY', '2000.20', '2012.00')).toThrow(/already been reached/);
    expect(check('SELL', '2000.00', '1990.00')).toThrow(/already been reached/);
    expect(check('BUY', '1990.00', '2012.00')).toThrow(/must be above/);
    expect(check('BUY', '1990.00', '2012.00')).toThrow(/BUY LIMIT at 2012.00/);
  });

  it('holds both prices to the tick grid and to being positive', () => {
    expect(check('BUY', '2010.005', '2012.00')).toThrow(/tick size/);
    expect(check('BUY', '2010.00', '2012.005')).toThrow(/tick size/);
    expect(check('BUY', '2010.00', '0')).toThrow(/positive/);
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
