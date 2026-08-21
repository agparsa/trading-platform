import { describe, expect, it } from 'vitest';
import { CloseReason, DomainError, TradingErrorCode } from '@tp/shared-types';
import {
  evaluateProtectiveTrigger,
  nextHighWater,
  nextTrailingStop,
  validateProtectiveLevels,
} from './protective-orders';
import { XAUUSD } from './__fixtures__/instruments';

const codeOf = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return (e as DomainError).code;
  }
  throw new Error('expected the call to throw');
};

describe('validateProtectiveLevels', () => {
  // Matches the reference terminal: BUY XAUUSD @ 4585.57, SL 4525.79, TP 4653.65.
  it('accepts levels straddling a long entry', () => {
    expect(() =>
      validateProtectiveLevels(XAUUSD, 'BUY', '4585.57', {
        stopLoss: '4525.79',
        takeProfit: '4653.65',
      }),
    ).not.toThrow();
  });

  it('accepts the mirrored levels for a short', () => {
    expect(() =>
      validateProtectiveLevels(XAUUSD, 'SELL', '4585.57', {
        stopLoss: '4653.65',
        takeProfit: '4525.79',
      }),
    ).not.toThrow();
  });

  it('rejects a long stop-loss above entry, which would fire immediately', () => {
    expect(
      codeOf(() =>
        validateProtectiveLevels(XAUUSD, 'BUY', '4585.57', {
          stopLoss: '4600.00',
          takeProfit: null,
        }),
      ),
    ).toBe(TradingErrorCode.INVALID_STOP_LOSS);
  });

  it('rejects a long take-profit below entry', () => {
    expect(
      codeOf(() =>
        validateProtectiveLevels(XAUUSD, 'BUY', '4585.57', {
          stopLoss: null,
          takeProfit: '4500.00',
        }),
      ),
    ).toBe(TradingErrorCode.INVALID_TAKE_PROFIT);
  });

  it('rejects a level that is off the tick grid', () => {
    expect(
      codeOf(() =>
        validateProtectiveLevels(XAUUSD, 'BUY', '4585.57', {
          stopLoss: '4525.795',
          takeProfit: null,
        }),
      ),
    ).toBe(TradingErrorCode.INVALID_STOP_LOSS);
  });

  it('rejects a non-positive level', () => {
    expect(
      codeOf(() =>
        validateProtectiveLevels(XAUUSD, 'BUY', '4585.57', { stopLoss: '0', takeProfit: null }),
      ),
    ).toBe(TradingErrorCode.INVALID_STOP_LOSS);
  });

  it('accepts a position with no protective levels at all', () => {
    expect(() =>
      validateProtectiveLevels(XAUUSD, 'BUY', '4585.57', { stopLoss: null, takeProfit: null }),
    ).not.toThrow();
  });
});

describe('evaluateProtectiveTrigger', () => {
  const levels = { stopLoss: '4525.79', takeProfit: '4653.65' };

  it('does not fire while price sits between the levels', () => {
    expect(evaluateProtectiveTrigger('BUY', levels, { bid: '4583.58', ask: '4583.72' })).toBeNull();
  });

  it('fires a long stop-loss on the bid, not the ask', () => {
    // Bid has crossed the stop; ask has not. A long closes on the bid, so it fires.
    expect(evaluateProtectiveTrigger('BUY', levels, { bid: '4525.79', ask: '4525.93' })).toBe(
      CloseReason.STOP_LOSS,
    );
  });

  it('fires a long take-profit on the bid', () => {
    expect(evaluateProtectiveTrigger('BUY', levels, { bid: '4653.65', ask: '4653.79' })).toBe(
      CloseReason.TAKE_PROFIT,
    );
  });

  it('fires a short stop-loss on the ask, not the bid', () => {
    const shortLevels = { stopLoss: '4653.65', takeProfit: '4525.79' };
    expect(evaluateProtectiveTrigger('SELL', shortLevels, { bid: '4653.51', ask: '4653.65' })).toBe(
      CloseReason.STOP_LOSS,
    );
    expect(
      evaluateProtectiveTrigger('SELL', shortLevels, { bid: '4653.40', ask: '4653.54' }),
    ).toBeNull();
  });

  it('resolves a tick that spans both levels in favour of the stop-loss', () => {
    // A single gapping tick below SL and above TP is ambiguous; we never
    // silently pick the profitable branch.
    expect(
      evaluateProtectiveTrigger(
        'BUY',
        { stopLoss: '4600.00', takeProfit: '4500.00' },
        {
          bid: '4400.00',
          ask: '4400.14',
        },
      ),
    ).toBe(CloseReason.STOP_LOSS);
  });

  it('ignores levels that are not set', () => {
    expect(
      evaluateProtectiveTrigger(
        'BUY',
        { stopLoss: null, takeProfit: null },
        { bid: '1', ask: '2' },
      ),
    ).toBeNull();
  });
});

describe('trailing stop', () => {
  it('tracks the best exit price seen', () => {
    expect(nextHighWater('BUY', null, { bid: '4583.58', ask: '4583.72' })).toBe('4583.58');
    expect(nextHighWater('BUY', '4583.58', { bid: '4590.00', ask: '4590.14' })).toBe('4590');
    expect(nextHighWater('BUY', '4590.00', { bid: '4580.00', ask: '4580.14' })).toBe('4590');
    expect(nextHighWater('SELL', '4590.00', { bid: '4580.00', ask: '4580.14' })).toBe('4580.14');
  });

  it('moves a long stop up but never back down', () => {
    expect(nextTrailingStop(XAUUSD, 'BUY', '10.00', '4590.00', null)).toBe('4580');
    expect(nextTrailingStop(XAUUSD, 'BUY', '10.00', '4600.00', '4580.00')).toBe('4590');
    expect(nextTrailingStop(XAUUSD, 'BUY', '10.00', '4590.00', '4590.00')).toBeNull();
  });

  it('moves a short stop down but never back up', () => {
    expect(nextTrailingStop(XAUUSD, 'SELL', '10.00', '4580.00', '4600.00')).toBe('4590');
    expect(nextTrailingStop(XAUUSD, 'SELL', '10.00', '4600.00', '4590.00')).toBeNull();
  });

  it('snaps the derived stop onto the tick grid', () => {
    expect(nextTrailingStop(XAUUSD, 'BUY', '10.005', '4590.00', null)).toBe('4580');
  });

  it('rejects a non-positive trailing distance', () => {
    expect(() => nextTrailingStop(XAUUSD, 'BUY', '0', '4590.00', null)).toThrow(DomainError);
  });
});
