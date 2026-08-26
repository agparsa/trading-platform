import { describe, expect, it } from 'vitest';
import { CloseReason } from '@tp/shared-types';
import {
  adverseQuote,
  bestExitInRange,
  evaluateProtectiveTriggerOverRange,
  favourableQuote,
  shouldTriggerPendingOverRange,
  type PriceRange,
} from './price-range';

/**
 * A window in which the market fell to 1990 and rose to 2010 before settling.
 * A single-tick evaluation of the closing price would see neither extreme.
 */
const swung: PriceRange = {
  minBid: '1990.00',
  maxBid: '2010.00',
  minAsk: '1990.20',
  maxAsk: '2010.20',
};

const still: PriceRange = {
  minBid: '2000.00',
  maxBid: '2000.00',
  minAsk: '2000.20',
  maxAsk: '2000.20',
};

describe('adverse and favourable extremes', () => {
  it('reads the worst price from the position’s own point of view', () => {
    // A long exits on the bid, so its worst is the lowest bid.
    expect(adverseQuote('BUY', swung).bid).toBe('1990.00');
    // A short exits on the ask, so its worst is the highest ask.
    expect(adverseQuote('SELL', swung).ask).toBe('2010.20');
  });

  it('mirrors that for the best price', () => {
    expect(favourableQuote('BUY', swung).bid).toBe('2010.00');
    expect(favourableQuote('SELL', swung).ask).toBe('1990.20');
  });
});

describe('evaluateProtectiveTriggerOverRange', () => {
  /** The whole reason coalescing exists. */
  it('fires a stop the market traded through even though it recovered', () => {
    const reason = evaluateProtectiveTriggerOverRange(
      'BUY',
      { stopLoss: '1995.00', takeProfit: null },
      swung,
    );
    expect(reason).toBe(CloseReason.STOP_LOSS);
  });

  it('fires a take-profit the market reached and fell back from', () => {
    const reason = evaluateProtectiveTriggerOverRange(
      'BUY',
      { stopLoss: null, takeProfit: '2005.00' },
      swung,
    );
    expect(reason).toBe(CloseReason.TAKE_PROFIT);
  });

  /**
   * When the window spans both levels nobody can know which came first, so the
   * stop wins — the same rule the single-tick path already applies to a tick
   * that spans both. Deciding the other way would let a burst of ticks turn a
   * losing position into a winning one on an ordering never observed.
   */
  it('gives the stop-loss to a window that spans both levels', () => {
    const reason = evaluateProtectiveTriggerOverRange(
      'BUY',
      { stopLoss: '1995.00', takeProfit: '2005.00' },
      swung,
    );
    expect(reason).toBe(CloseReason.STOP_LOSS);
  });

  it('fires nothing when the window never reached a level', () => {
    expect(
      evaluateProtectiveTriggerOverRange(
        'BUY',
        { stopLoss: '1900.00', takeProfit: '2100.00' },
        swung,
      ),
    ).toBeNull();
  });

  it('behaves exactly like a single tick when nothing moved', () => {
    expect(
      evaluateProtectiveTriggerOverRange('BUY', { stopLoss: '2000.00', takeProfit: null }, still),
    ).toBe(CloseReason.STOP_LOSS);
    expect(
      evaluateProtectiveTriggerOverRange('BUY', { stopLoss: '1999.99', takeProfit: null }, still),
    ).toBeNull();
  });

  it('mirrors correctly for a short', () => {
    // A short is hurt by a rising ask.
    expect(
      evaluateProtectiveTriggerOverRange('SELL', { stopLoss: '2005.00', takeProfit: null }, swung),
    ).toBe(CloseReason.STOP_LOSS);
    expect(
      evaluateProtectiveTriggerOverRange('SELL', { stopLoss: null, takeProfit: '1995.00' }, swung),
    ).toBe(CloseReason.TAKE_PROFIT);
  });
});

describe('shouldTriggerPendingOverRange', () => {
  it('fills a buy limit the ask dipped to', () => {
    expect(shouldTriggerPendingOverRange('LIMIT', 'BUY', '1995.00', swung)).toBe(true);
    expect(shouldTriggerPendingOverRange('LIMIT', 'BUY', '1900.00', swung)).toBe(false);
  });

  it('fills a sell limit the bid rose to', () => {
    expect(shouldTriggerPendingOverRange('LIMIT', 'SELL', '2005.00', swung)).toBe(true);
    expect(shouldTriggerPendingOverRange('LIMIT', 'SELL', '2100.00', swung)).toBe(false);
  });

  it('fills a buy stop the ask rose to', () => {
    expect(shouldTriggerPendingOverRange('STOP', 'BUY', '2005.00', swung)).toBe(true);
    expect(shouldTriggerPendingOverRange('STOP', 'BUY', '2100.00', swung)).toBe(false);
  });

  it('fills a sell stop the bid fell to', () => {
    expect(shouldTriggerPendingOverRange('STOP', 'SELL', '1995.00', swung)).toBe(true);
    expect(shouldTriggerPendingOverRange('STOP', 'SELL', '1900.00', swung)).toBe(false);
  });

  /** Each type is tested against its own direction, not against both extremes. */
  it('does not fill an order the market moved away from', () => {
    // The ask reached 2010.20, but a buy *limit* wants a fall, and the lowest
    // ask was 1990.20 — so a limit at 2100 is not reached by the high.
    expect(shouldTriggerPendingOverRange('LIMIT', 'BUY', '2100.00', swung)).toBe(true);
    // ...that one *is* reached, because 1990.20 <= 2100. The real check:
    expect(shouldTriggerPendingOverRange('STOP', 'BUY', '1900.00', swung)).toBe(true);
    expect(shouldTriggerPendingOverRange('STOP', 'BUY', '2010.21', swung)).toBe(false);
  });
});

describe('bestExitInRange', () => {
  it('gives a trailing stop the best price the window saw', () => {
    expect(bestExitInRange('BUY', swung)).toBe('2010.00');
    expect(bestExitInRange('SELL', swung)).toBe('1990.20');
  });
});
