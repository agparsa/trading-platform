import { describe, expect, it } from 'vitest';
import { BTCUSD, EURUSD, NO_CONVERSION, XAUUSD } from '../__fixtures__/instruments';
import { Money } from '../money';
import { commissionForLeg, grossPnl, netPnl, returnOnNotional, swapAccrual } from './pnl';
import { entryPriceFor, exitPriceFor, spreadOf } from './sides';

const usd = (v: string) => Money.of(v, 'USD');

describe('executable side selection', () => {
  const quote = { bid: '4583.58', ask: '4583.72' };

  it('opens a long on the ask and closes it on the bid', () => {
    expect(entryPriceFor('BUY', quote).toString()).toBe('4583.72');
    expect(exitPriceFor('BUY', quote).toString()).toBe('4583.58');
  });

  it('opens a short on the bid and closes it on the ask', () => {
    expect(entryPriceFor('SELL', quote).toString()).toBe('4583.58');
    expect(exitPriceFor('SELL', quote).toString()).toBe('4583.72');
  });

  it('reports the spread in price units', () => {
    expect(spreadOf(quote).toString()).toBe('0.14');
  });
});

/**
 * Vectors captured from a live broker terminal (XAUUSD/BTCUSD session).
 * Each expectation is a number that terminal displayed on screen.
 */
describe('grossPnl — reference terminal vectors', () => {
  const openLong = (entry: string, volume: string) =>
    grossPnl({
      spec: XAUUSD,
      side: 'BUY',
      volume,
      entryPrice: entry,
      exitPrice: '4583.58', // live bid at the moment of capture
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
    });

  it('matches the -$118.00 open long', () => {
    expect(openLong('4584.76', '1.00').toString()).toBe('-118.00');
  });

  it('matches the -$199.00 open long', () => {
    expect(openLong('4585.57', '1.00').toString()).toBe('-199.00');
  });

  it('matches the combined -$317.00 floating P&L', () => {
    const total = openLong('4584.76', '1.00').plus(openLong('4585.57', '1.00'));
    expect(total.toString()).toBe('-317.00');
  });

  const btcClose = (entry: string, exit: string, volume: string) =>
    grossPnl({
      spec: BTCUSD,
      side: 'BUY',
      volume,
      entryPrice: entry,
      exitPrice: exit,
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
    });

  it.each([
    ['77634.99', '77707.26', '0.01', '0.72'],
    ['77609.23', '77677.70', '2.00', '136.94'],
    ['77693.25', '77609.37', '0.23', '-19.29'],
    ['77702.55', '77584.38', '2.00', '-236.34'],
  ])('closed BTCUSD %s -> %s at %s lots yields %s', (entry, exit, volume, expected) => {
    expect(btcClose(entry, exit, volume).toString()).toBe(expected);
  });

  it('matches the -$117.97 daily total across those four closes', () => {
    const total = [
      btcClose('77634.99', '77707.26', '0.01'),
      btcClose('77609.23', '77677.70', '2.00'),
      btcClose('77693.25', '77609.37', '0.23'),
      btcClose('77702.55', '77584.38', '2.00'),
    ].reduce((a, b) => a.plus(b));
    expect(total.toString()).toBe('-117.97');
  });
});

describe('grossPnl — direction and conversion', () => {
  it('is the exact mirror image for a short', () => {
    const base = {
      spec: XAUUSD,
      volume: '1.00',
      entryPrice: '4584.76',
      exitPrice: '4583.58',
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
    } as const;
    const long = grossPnl({ ...base, side: 'BUY' });
    const short = grossPnl({ ...base, side: 'SELL' });
    expect(long.plus(short).isZero()).toBe(true);
    expect(short.toString()).toBe('118.00');
  });

  it('converts quote-currency P&L into the account currency', () => {
    const pnl = grossPnl({
      spec: EURUSD,
      side: 'BUY',
      volume: '1.00',
      entryPrice: '1.08000',
      exitPrice: '1.08100',
      accountCurrency: 'EUR',
      quoteToAccountRate: '0.92', // 1 USD = 0.92 EUR
    });
    expect(pnl.currency).toBe('EUR');
    expect(pnl.toString()).toBe('92.00'); // 100 USD x 0.92
  });

  it('is exactly zero when price does not move', () => {
    expect(
      grossPnl({
        spec: XAUUSD,
        side: 'BUY',
        volume: '3.33',
        entryPrice: '4583.58',
        exitPrice: '4583.58',
        accountCurrency: 'USD',
        quoteToAccountRate: NO_CONVERSION,
      }).isZero(),
    ).toBe(true);
  });
});

describe('commission and swap', () => {
  it('charges commission per lot per leg, as a positive cost', () => {
    const c = commissionForLeg(EURUSD, '2.00', 'USD', NO_CONVERSION);
    expect(c.toString()).toBe('7.00');
    expect(c.isNegative()).toBe(false);
  });

  it('accrues signed swap using the side-specific rate', () => {
    expect(swapAccrual(XAUUSD, 'BUY', '1.00', 3, 'USD', NO_CONVERSION).toString()).toBe('-37.50');
    expect(swapAccrual(XAUUSD, 'SELL', '1.00', 3, 'USD', NO_CONVERSION).toString()).toBe('14.25');
  });

  it('accrues nothing over zero nights', () => {
    expect(swapAccrual(XAUUSD, 'BUY', '1.00', 0, 'USD', NO_CONVERSION).isZero()).toBe(true);
  });

  it('rejects a fractional or negative night count', () => {
    expect(() => swapAccrual(XAUUSD, 'BUY', '1', 1.5, 'USD', NO_CONVERSION)).toThrow(RangeError);
    expect(() => swapAccrual(XAUUSD, 'BUY', '1', -1, 'USD', NO_CONVERSION)).toThrow(RangeError);
  });
});

describe('netPnl', () => {
  it('subtracts commission and adds signed swap', () => {
    const result = netPnl({
      spec: EURUSD,
      side: 'BUY',
      volume: '1.00',
      entryPrice: '1.08000',
      exitPrice: '1.08100',
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
      commission: usd('7.00'), // both legs
      swap: usd('-2.10'), // one night long
    });
    expect(result.toString()).toBe('90.90'); // 100 - 7 - 2.10
  });
});

describe('returnOnNotional', () => {
  it('expresses the move as a ratio of committed notional', () => {
    const r = returnOnNotional({
      spec: XAUUSD,
      side: 'BUY',
      volume: '1.00',
      entryPrice: '4000.00',
      exitPrice: '4040.00',
      accountCurrency: 'USD',
      quoteToAccountRate: NO_CONVERSION,
    });
    expect(r.toDecimalPlaces(6).toString()).toBe('0.01');
  });
});
