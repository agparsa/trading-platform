import { describe, expect, it } from 'vitest';
import { Money } from '../money';
import {
  computeAccountState,
  equity,
  freeMargin,
  isMarginCall,
  isStopOut,
  marginLevel,
  marginUtilization,
} from './account';

const usd = (v: string) => Money.of(v, 'USD');

/**
 * Reference terminal snapshot:
 *   Balance 99,882.03 | Floating P&L -317.00 | Equity 99,565.03
 *   Used margin 9,167.30 | Available funds 90,397.73 | "Margin level" 9.21%
 */
describe('account state — reference terminal snapshot', () => {
  const state = computeAccountState({
    currency: 'USD',
    balance: usd('99882.03'),
    floatingPnl: usd('-317.00'),
    usedMargin: usd('9167.30'),
  });

  it('derives equity as balance plus floating P&L', () => {
    expect(state.equity.toString()).toBe('99565.03');
  });

  it('derives free margin as equity minus used margin', () => {
    expect(state.freeMargin.toString()).toBe('90397.73');
  });

  it('reports MetaTrader-style margin level', () => {
    expect(state.marginLevel?.toDecimalPlaces(2).toString()).toBe('1086.09');
  });

  it('reports the utilisation percentage the reference terminal labels "Margin Level"', () => {
    expect(marginUtilization(state.equity, state.usedMargin)?.toDecimalPlaces(2).toString()).toBe(
      '9.21',
    );
  });
});

describe('margin level edge cases', () => {
  it('is null, not Infinity, when nothing is committed', () => {
    expect(marginLevel(usd('10000'), usd('0'))).toBeNull();
    expect(marginUtilization(usd('0'), usd('0'))).toBeNull();
  });

  it('never triggers a stop-out on an account with no open positions', () => {
    const flat = computeAccountState({
      currency: 'USD',
      balance: usd('50'),
      floatingPnl: usd('0'),
      usedMargin: usd('0'),
    });
    expect(isStopOut(flat, '50')).toBe(false);
    expect(isMarginCall(flat, '100')).toBe(false);
  });

  it('triggers a stop-out at or below the configured level', () => {
    const stressed = computeAccountState({
      currency: 'USD',
      balance: usd('10000'),
      floatingPnl: usd('-9500'),
      usedMargin: usd('1000'),
    });
    expect(stressed.marginLevel?.toString()).toBe('50');
    expect(isStopOut(stressed, '50')).toBe(true);
    expect(isStopOut(stressed, '20')).toBe(false);
    expect(isMarginCall(stressed, '100')).toBe(true);
  });
});

describe('primitive formulas', () => {
  it('compose into the same result as computeAccountState', () => {
    const balance = usd('12345.67');
    const floating = usd('-89.10');
    const used = usd('2000.00');
    const eq = equity(balance, floating);
    expect(eq.toString()).toBe('12256.57');
    expect(freeMargin(eq, used).toString()).toBe('10256.57');
  });
});
