import { describe, expect, it } from 'vitest';
import {
  estimateCosts,
  projectedOutcome,
  rewardToRisk,
  stepVolume,
  validateRestingPrice,
  validateTicket,
} from './ticket';
import type { AccountSummary, SymbolRow } from './queries';

const XAUUSD: SymbolRow = {
  code: 'XAUUSD',
  description: 'Gold vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '5',
  swapLongPerLot: '-2.5',
  swapShortPerLot: '1.2',
  enabled: true,
  sessionOpen: true,
};

const account: AccountSummary = {
  id: 'a1',
  number: '100001',
  type: 'DEMO',
  status: 'ACTIVE',
  currency: 'USD',
  balance: '100000.00',
  leverage: 100,
  createdAt: new Date(0).toISOString(),
};

describe('stepVolume', () => {
  it('adds one lot step', () => {
    expect(stepVolume(XAUUSD, '0.10', 1)).toBe('0.11');
  });

  it('never steps below the instrument minimum', () => {
    expect(stepVolume(XAUUSD, '0.01', -1)).toBe('0.01');
  });

  it('recovers from a field the trader has half-typed', () => {
    expect(stepVolume(XAUUSD, 'abc', 1)).toBe('0.02');
  });
});

describe('validateTicket', () => {
  it('accepts a well-formed order', () => {
    expect(validateTicket(XAUUSD, 'BUY', '0.10', '', '', '2000.00').error).toBeNull();
  });

  it('rejects a volume below the instrument minimum', () => {
    expect(validateTicket(XAUUSD, 'BUY', '0.001', '', '', '2000.00').error).toContain('Minimum');
  });

  it('rejects a volume off the lot step', () => {
    expect(validateTicket(XAUUSD, 'BUY', '0.105', '', '', '2000.00').error).toContain('multiple');
  });

  it('rejects a volume above the instrument maximum', () => {
    expect(validateTicket(XAUUSD, 'BUY', '51', '', '', '2000.00').error).toContain('Maximum');
  });

  /**
   * The rule that matters most here. A long's stop below the market is
   * protection; above it, the position closes on the next tick — so the ticket
   * must refuse it rather than let the server do it a round trip later.
   */
  it("refuses a long's stop-loss placed above the market", () => {
    const result = validateTicket(XAUUSD, 'BUY', '0.10', '2001.00', '', '2000.00');
    expect(result.error).toContain('below');
  });

  it("refuses a short's stop-loss placed below the market", () => {
    const result = validateTicket(XAUUSD, 'SELL', '0.10', '1999.00', '', '2000.00');
    expect(result.error).toContain('above');
  });

  it('accepts protective levels on the correct side', () => {
    expect(validateTicket(XAUUSD, 'BUY', '0.10', '1990.00', '2010.00', '2000.00').error).toBeNull();
    expect(
      validateTicket(XAUUSD, 'SELL', '0.10', '2010.00', '1990.00', '2000.00').error,
    ).toBeNull();
  });

  it('rejects a stop-loss off the tick grid', () => {
    expect(validateTicket(XAUUSD, 'BUY', '0.10', '1990.005', '', '2000.00').error).toContain(
      'tick size',
    );
  });

  /**
   * With no price to measure against, side validation is not merely skipped —
   * it is impossible. Inventing a reference would let a wrong-side stop through
   * on the strength of a made-up number.
   */
  it('does not judge protective levels when no quote has arrived', () => {
    expect(validateTicket(XAUUSD, 'BUY', '0.10', '9999.00', '', null).error).toBeNull();
  });

  it('reports a half-typed volume without claiming the volume is valid', () => {
    const result = validateTicket(XAUUSD, 'BUY', '0.', '', '', '2000.00');
    expect(result.error).not.toBeNull();
    expect(result.volumeOk).toBe(false);
  });
});

describe('estimateCosts', () => {
  /**
   * 0.10 lots of a 100-unit contract at 2000.00 is 20,000 notional. The
   * account's 100:1 leverage and the instrument's 1% rate agree, so margin is
   * 200.00 — the same figure `requiredMargin` gives the server.
   */
  it('prices margin with the same formula the engine uses', () => {
    const estimate = estimateCosts(XAUUSD, account, '0.10', '2000.00', true);
    expect(estimate.margin).toBe('$200.00');
    expect(estimate.commission).toBe('$0.50');
  });

  it('shows nothing rather than a guess when the currencies differ', () => {
    const eurAccount = { ...account, currency: 'EUR' };
    expect(estimateCosts(XAUUSD, eurAccount, '0.10', '2000.00', true)).toEqual({
      margin: '—',
      commission: '—',
      // And no raw figure either: the checks that compare margin against the
      // account must not be handed a number computed at an assumed rate.
      marginAmount: null,
    });
  });

  it('shows nothing before a quote has arrived', () => {
    expect(estimateCosts(XAUUSD, account, '0.10', null, true).margin).toBe('—');
  });

  it('shows nothing for a volume that failed validation', () => {
    expect(estimateCosts(XAUUSD, account, '0.105', '2000.00', false).margin).toBe('—');
  });

  /** The instrument's own rate is a floor, so more account leverage cannot undercut it. */
  it('does not let account leverage undercut the instrument margin rate', () => {
    const leveraged = { ...account, leverage: 500 };
    expect(estimateCosts(XAUUSD, leveraged, '0.10', '2000.00', true).margin).toBe('$200.00');
  });
});

describe('validateRestingPrice', () => {
  const quote = { bid: '2000.00', ask: '2000.20' };

  it('accepts each of the four orders resting on its correct side', () => {
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'BUY', '1990.00', quote)).toBeNull();
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'SELL', '2010.00', quote)).toBeNull();
    expect(validateRestingPrice(XAUUSD, 'STOP', 'BUY', '2010.00', quote)).toBeNull();
    expect(validateRestingPrice(XAUUSD, 'STOP', 'SELL', '1990.00', quote)).toBeNull();
  });

  /** The mistake that turns a resting order into an unasked-for market order. */
  it('rejects each of the four placed on the wrong side', () => {
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'BUY', '2010.00', quote)).toContain('below');
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'SELL', '1990.00', quote)).toContain('above');
    expect(validateRestingPrice(XAUUSD, 'STOP', 'BUY', '1990.00', quote)).toContain('above');
    expect(validateRestingPrice(XAUUSD, 'STOP', 'SELL', '2010.00', quote)).toContain('below');
  });

  it('asks for a price rather than complaining about an empty field', () => {
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'BUY', '   ', quote)).toContain('Enter the price');
  });

  it('reports a half-typed price without pretending it is valid', () => {
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'BUY', '19.', quote)).toContain('decimal');
  });

  it('rejects a price off the tick grid', () => {
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'BUY', '1990.005', quote)).toContain('tick size');
  });

  /**
   * With no quote there is nothing to measure the side against. Guessing would
   * be worse than deferring: the server has a price and will refuse the order.
   */
  it('defers to the server when no quote has arrived', () => {
    expect(validateRestingPrice(XAUUSD, 'LIMIT', 'BUY', '2010.00', undefined)).toBeNull();
  });
});

describe('projectedOutcome', () => {
  it('projects what a stop would cost from the entry the order will open at', () => {
    // Long 1 lot of gold, 100 oz, entry 4583.72, stop 4580.00 → −372.00.
    const projected = projectedOutcome(XAUUSD, account, 'BUY', '1', '4583.72', '4580.00');
    expect(Number(projected)).toBeCloseTo(-372, 6);
  });

  it('projects what a target would pay', () => {
    const projected = projectedOutcome(XAUUSD, account, 'BUY', '1', '4583.72', '4590.00');
    expect(Number(projected)).toBeCloseTo(628, 6);
  });

  it('reverses for a short', () => {
    const projected = projectedOutcome(XAUUSD, account, 'SELL', '1', '4583.72', '4580.00');
    expect(Number(projected)).toBeCloseTo(372, 6);
  });

  /**
   * The same rule `estimateCosts` follows. Converting would mean inventing an FX
   * rate this browser does not hold, and a wrong number is worse than none.
   */
  it('refuses to convert when the instrument is not quoted in the account currency', () => {
    const eurAccount = { ...account, currency: 'EUR' };
    expect(projectedOutcome(XAUUSD, eurAccount, 'BUY', '1', '4583.72', '4580.00')).toBeNull();
  });

  it('says nothing rather than zero when a level is missing or half-typed', () => {
    expect(projectedOutcome(XAUUSD, account, 'BUY', '1', '4583.72', '')).toBeNull();
    expect(projectedOutcome(XAUUSD, account, 'BUY', '1', '4583.72', '458.')).toBeNull();
    expect(projectedOutcome(XAUUSD, account, 'BUY', '1', null, '4580.00')).toBeNull();
    expect(projectedOutcome(undefined, account, 'BUY', '1', '4583.72', '4580.00')).toBeNull();
  });
});

describe('rewardToRisk', () => {
  it('divides the projected gain by the projected loss', () => {
    expect(rewardToRisk('628', '-372')).toBe('1.69');
  });

  /**
   * A "risk" that is positive means the stop sits on the profitable side of the
   * entry, which is not a stop. Printing a ratio for it would be a confident,
   * meaningless number.
   */
  it('refuses a ratio when the stop is on the wrong side', () => {
    expect(rewardToRisk('628', '372')).toBeNull();
  });

  it('refuses a ratio when the target loses money', () => {
    expect(rewardToRisk('-100', '-372')).toBeNull();
  });

  it('says nothing when either side is missing', () => {
    expect(rewardToRisk(null, '-372')).toBeNull();
    expect(rewardToRisk('628', null)).toBeNull();
  });
});
