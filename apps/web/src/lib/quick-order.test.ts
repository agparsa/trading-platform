import { describe, expect, it } from 'vitest';
import type { AccountSummary, SymbolRow } from './queries';
import { resolveQuickOrder, type QuickOrderInput, type QuickOrderProblem } from './quick-order';

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
  balance: '10000.00',
  leverage: 100,
  createdAt: new Date(0).toISOString(),
};

const WORDS: Record<QuickOrderProblem, string> = {
  noPrice: 'noPrice',
  stopPoints: 'stopPoints',
  takePoints: 'takePoints',
  riskNeedsStop: 'riskNeedsStop',
  riskPercent: 'riskPercent',
  riskTooSmall: 'riskTooSmall',
};

const base: QuickOrderInput = {
  spec: XAUUSD,
  account,
  equity: '10000.00',
  side: 'BUY',
  entry: '2000.00',
  volume: '0.10',
  stopPoints: '',
  takePoints: '',
  riskPercent: '',
};

describe('resolveQuickOrder', () => {
  it('sends the lots alone when nothing else is asked for', () => {
    expect(resolveQuickOrder(base, WORDS)).toMatchObject({
      volume: '0.10',
      stopLoss: null,
      takeProfit: null,
      error: null,
    });
  });

  it('puts a buy’s stop below and its target above, a sell’s the other way', () => {
    const buy = resolveQuickOrder({ ...base, stopPoints: '500', takePoints: '1000' }, WORDS);
    // 500 points of a 2-decimal price is 5.00.
    expect(buy).toMatchObject({ stopLoss: '1995.00', takeProfit: '2010.00', error: null });
    // 0.10 lots × 100 oz × $5 = $50 at risk, $100 in view.
    expect(Number(buy.ifStopped)).toBe(-50);
    expect(Number(buy.ifTargeted)).toBe(100);

    const sell = resolveQuickOrder(
      { ...base, side: 'SELL', entry: '1999.80', stopPoints: '500', takePoints: '1000' },
      WORDS,
    );
    expect(sell).toMatchObject({ stopLoss: '2004.80', takeProfit: '1989.80', error: null });
  });

  it('sizes the lots so the stop costs the share of equity asked for', () => {
    // 1% of $10,000 is $100; a $5 stop on gold is $500 a lot, so 0.20 lots.
    const sized = resolveQuickOrder({ ...base, stopPoints: '500', riskPercent: '1' }, WORDS);
    expect(sized).toMatchObject({ volume: '0.20', stopLoss: '1995.00', error: null });
    expect(Number(sized.ifStopped)).toBe(-100);
  });

  it('refuses risk sizing without a stop, rather than guessing one', () => {
    expect(resolveQuickOrder({ ...base, riskPercent: '1' }, WORDS).error).toBe('riskNeedsStop');
  });

  it('refuses a risk too small to buy the minimum lot', () => {
    // $1 against a $5 stop is 0.002 lots — below the 0.01 minimum.
    expect(
      resolveQuickOrder({ ...base, stopPoints: '500', riskPercent: '0.01' }, WORDS).error,
    ).toBe('riskTooSmall');
  });

  it('refuses half-typed or nonsensical entries in words, not a wrong price', () => {
    expect(resolveQuickOrder({ ...base, stopPoints: '5.5' }, WORDS).error).toBe('stopPoints');
    expect(resolveQuickOrder({ ...base, takePoints: '-3' }, WORDS).error).toBe('takePoints');
    expect(resolveQuickOrder({ ...base, stopPoints: '500', riskPercent: '150' }, WORDS).error).toBe(
      'riskPercent',
    );
    expect(resolveQuickOrder({ ...base, entry: null }, WORDS).error).toBe('noPrice');
  });
});
