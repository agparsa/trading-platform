import { describe, expect, it } from 'vitest';
import { XAUUSD } from './__fixtures__/instruments';
import {
  distanceBetween,
  levelView,
  outcomeAt,
  percentOfEquity,
  priceAtDistance,
  priceAtPoints,
  rewardToRisk,
  volumeForRisk,
} from './levels';

/**
 * The calculator every screen shares.
 *
 * These are the numbers a trader reads while choosing a stop, and until this
 * file they were computed in four places — the ticket, the chart's drag
 * handler, the points helper and the phone — each free to disagree with the
 * others. The disagreement would only ever be visible to the person who set a
 * level on the chart and read a different figure in the ticket, which is the
 * worst possible way to find out.
 */
describe('protective-level calculator', () => {
  const base = {
    spec: XAUUSD,
    side: 'BUY' as const,
    volume: '1',
    entryPrice: '4000',
    accountCurrency: 'USD',
    quoteToAccountRate: '1',
  };

  describe('distance', () => {
    it('measures in price and in the instrument’s own points', () => {
      // Gold shows two decimals, so a point is 0.01 and $12 is 1200 points.
      expect(distanceBetween('4000', '3988', 2)).toEqual({ price: '12', points: 1200 });
      // A five-decimal pair: the same words, a different unit.
      expect(distanceBetween('1.10000', '1.09880', 5)).toEqual({ price: '0.0012', points: 120 });
    });

    it('is unsigned, because which side a level sits on is not a distance', () => {
      expect(distanceBetween('4000', '4012', 2)?.points).toBe(1200);
      expect(distanceBetween('4012', '4000', 2)?.points).toBe(1200);
    });

    it('answers null rather than a number for input it cannot read', () => {
      expect(distanceBetween('', '4000', 2)).toBe(null);
      expect(distanceBetween('4000', 'abc', 2)).toBe(null);
      expect(distanceBetween('4000', '3988', -1)).toBe(null);
      expect(distanceBetween('4000', '3988', 2.5)).toBe(null);
    });
  });

  describe('a price from a distance', () => {
    /**
     * The direction is derived, never asked for. A caller that had to work it
     * out is a caller that can get it wrong, and a "stop" on the profitable
     * side is an order that protects nothing.
     */
    it('puts a stop below a long and above a short', () => {
      expect(priceAtDistance('4000', '12', 'BUY', 'STOP_LOSS')).toBe('3988');
      expect(priceAtDistance('4000', '12', 'SELL', 'STOP_LOSS')).toBe('4012');
    });

    it('puts a target above a long and below a short', () => {
      expect(priceAtDistance('4000', '25', 'BUY', 'TAKE_PROFIT')).toBe('4025');
      expect(priceAtDistance('4000', '25', 'SELL', 'TAKE_PROFIT')).toBe('3975');
    });

    it('ignores a sign somebody typed into the distance', () => {
      expect(priceAtDistance('4000', '-12', 'BUY', 'STOP_LOSS')).toBe('3988');
    });

    it('converts points to a price in the instrument’s own units', () => {
      expect(priceAtPoints('4000', 1200, 2, 'BUY', 'STOP_LOSS')).toBe('3988');
      expect(priceAtPoints('1.10000', 120, 5, 'BUY', 'STOP_LOSS')).toBe('1.0988');
    });

    it('round-trips: a price to a distance and back is where it started', () => {
      const distance = distanceBetween('4000', '3988.5', 2);
      expect(priceAtDistance('4000', distance?.price as string, 'BUY', 'STOP_LOSS')).toBe('3988.5');
    });
  });

  describe('what a level would cost or make', () => {
    it('values a stop as a loss and a target as a gain, on both sides', () => {
      // 1 lot of gold is 100 ounces: $12 against is $1,200. Carried to the
      // currency's own minor units, because it is money and not a ratio.
      expect(outcomeAt({ ...base, exitPrice: '3988' })).toBe('-1200.00');
      expect(outcomeAt({ ...base, exitPrice: '4025' })).toBe('2500.00');
      expect(outcomeAt({ ...base, side: 'SELL', exitPrice: '3988' })).toBe('1200.00');
      expect(outcomeAt({ ...base, side: 'SELL', exitPrice: '4025' })).toBe('-2500.00');
    });

    /**
     * The rule that keeps a screen honest across currencies. Assuming a rate
     * of 1 is how a euro-denominated account is shown a dollar figure that
     * looks right and is not.
     */
    it('answers null without a rate rather than assuming one', () => {
      expect(outcomeAt({ ...base, exitPrice: '3988', quoteToAccountRate: null })).toBe(null);
    });

    it('applies the rate it is given', () => {
      expect(outcomeAt({ ...base, exitPrice: '3988', quoteToAccountRate: '0.5' })).toBe('-600.00');
    });

    it('answers null for a half-typed level rather than throwing at a keystroke', () => {
      expect(outcomeAt({ ...base, exitPrice: '' })).toBe(null);
      expect(outcomeAt({ ...base, exitPrice: '39.' })).toBe(null);
      expect(outcomeAt({ ...base, volume: 'abc', exitPrice: '3988' })).toBe(null);
    });
  });

  describe('reward to risk', () => {
    it('is reward over the size of the risk', () => {
      expect(rewardToRisk('2500', '-1200')).toBe('2.08');
      expect(rewardToRisk('1200', '-1200')).toBe('1');
    });

    /**
     * A "risk" that is positive means the stop is on the profitable side —
     * the mistake the trader most needs to notice. Printing a confident ratio
     * over it would bury exactly that.
     */
    it('refuses to print a ratio over a stop on the wrong side', () => {
      expect(rewardToRisk('2500', '400')).toBe(null);
      expect(rewardToRisk('2500', '0')).toBe(null);
      expect(rewardToRisk('-100', '-1200')).toBe(null);
      expect(rewardToRisk(null, '-1200')).toBe(null);
    });
  });

  describe('as a percentage of equity', () => {
    it('is the number a trader actually manages by', () => {
      // "two percent" is a rule people follow; "$200" is not.
      expect(percentOfEquity('-200', '10000')).toBe('2');
      expect(percentOfEquity('250', '10000')).toBe('2.5');
    });

    it('is unsigned, because the label beside it already says which it is', () => {
      expect(percentOfEquity('-200', '10000')).toBe(percentOfEquity('200', '10000'));
    });

    it('answers null on an account with nothing in it, rather than Infinity', () => {
      expect(percentOfEquity('-200', '0')).toBe(null);
      expect(percentOfEquity('-200', '-50')).toBe(null);
      expect(percentOfEquity(null, '10000')).toBe(null);
    });
  });

  describe('the whole view of one level', () => {
    it('assembles the four figures from one arithmetic', () => {
      const view = levelView({
        spec: XAUUSD,
        side: 'BUY',
        volume: '1',
        entryPrice: '4000',
        levelPrice: '3988',
        accountCurrency: 'USD',
        quoteToAccountRate: '1',
        equity: '10000',
      });
      expect(view).toEqual({
        price: '3988',
        distance: { price: '12', points: 1200 },
        outcome: '-1200.00',
        percentOfEquity: '12',
      });
    });

    it('still gives the distance when it cannot give the money', () => {
      // Without a rate the price arithmetic is still true; only the money is
      // unknowable. Withholding both would hide a fact the screen has.
      const view = levelView({
        spec: XAUUSD,
        side: 'BUY',
        volume: '1',
        entryPrice: '4000',
        levelPrice: '3988',
        accountCurrency: 'EUR',
        quoteToAccountRate: null,
        equity: '10000',
      });
      expect(view?.distance).toEqual({ price: '12', points: 1200 });
      expect(view?.outcome).toBe(null);
      expect(view?.percentOfEquity).toBe(null);
    });
  });

  describe('sizing from the loss a trader will take', () => {
    it('gives the volume that risks exactly that much', () => {
      // $1,200 at a $12 stop on gold is one lot.
      expect(
        volumeForRisk({
          spec: XAUUSD,
          side: 'BUY',
          entryPrice: '4000',
          stopPrice: '3988',
          riskAmount: '1200',
          accountCurrency: 'USD',
          quoteToAccountRate: '1',
        }),
      ).toBe('1');
    });

    /**
     * Down, never up. A size that rounds up risks more than was asked for, and
     * the ceiling on the loss is the entire point of the number.
     */
    it('rounds down to the volume step, never up', () => {
      const volume = volumeForRisk({
        spec: XAUUSD,
        side: 'BUY',
        entryPrice: '4000',
        stopPrice: '3988',
        riskAmount: '1250',
        accountCurrency: 'USD',
        quoteToAccountRate: '1',
      });
      // 1.0416… lots rounds to 1.04, not 1.05.
      expect(volume).toBe('1.04');
      expect(
        Number(
          outcomeAt({
            spec: XAUUSD,
            side: 'BUY',
            volume: volume as string,
            entryPrice: '4000',
            exitPrice: '3988',
            accountCurrency: 'USD',
            quoteToAccountRate: '1',
          }),
        ),
      ).toBeGreaterThanOrEqual(-1250);
    });

    it('refuses to size from a stop on the profitable side', () => {
      expect(
        volumeForRisk({
          spec: XAUUSD,
          side: 'BUY',
          entryPrice: '4000',
          stopPrice: '4012',
          riskAmount: '1200',
          accountCurrency: 'USD',
          quoteToAccountRate: '1',
        }),
      ).toBe(null);
    });

    it('refuses a risk too small to buy the minimum size', () => {
      expect(
        volumeForRisk({
          spec: XAUUSD,
          side: 'BUY',
          entryPrice: '4000',
          stopPrice: '3988',
          riskAmount: '1',
          accountCurrency: 'USD',
          quoteToAccountRate: '1',
        }),
      ).toBe(null);
    });

    it('never exceeds the instrument’s largest size', () => {
      expect(
        volumeForRisk({
          spec: XAUUSD,
          side: 'BUY',
          entryPrice: '4000',
          stopPrice: '3999.99',
          riskAmount: '100000000',
          accountCurrency: 'USD',
          quoteToAccountRate: '1',
        }),
      ).toBe('100');
    });

    it('answers null without a rate rather than sizing on an assumed one', () => {
      expect(
        volumeForRisk({
          spec: XAUUSD,
          side: 'BUY',
          entryPrice: '4000',
          stopPrice: '3988',
          riskAmount: '1200',
          accountCurrency: 'EUR',
          quoteToAccountRate: null,
        }),
      ).toBe(null);
    });
  });
});
