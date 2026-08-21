import { describe, expect, it } from 'vitest';
import { Money, type SymbolSpec } from '@tp/financial-core';
import { TradingErrorCode } from '@tp/shared-types';
import { RiskEngine } from './engine';
import { DEFAULT_RISK_RULES } from './rules';
import type { AccountRiskLimits, ProposedOrder, RiskContext, SymbolExposure } from './types';

const XAUUSD: SymbolSpec = {
  code: 'XAUUSD',
  description: 'Gold vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '100',
  marginRate: '0.01',
  commissionPerLot: '0',
  swapLongPerLot: '-12.5',
  swapShortPerLot: '4.75',
  enabled: true,
};

const usd = (v: string) => Money.of(v, 'USD');

const order = (over: Partial<ProposedOrder> = {}): ProposedOrder => ({
  symbol: 'XAUUSD',
  spec: XAUUSD,
  side: 'BUY',
  volume: '1.00',
  price: '4583.65',
  requiredMargin: usd('4583.65'),
  notional: usd('458365.00'),
  ...over,
});

const context = (
  limits: AccountRiskLimits = {},
  over: Partial<RiskContext> = {},
  exposures: readonly SymbolExposure[] = [],
): RiskContext => ({
  accountId: 'acc-1',
  accountCurrency: 'USD',
  accountLeverage: '100',
  equity: usd('99565.03'),
  freeMargin: usd('90397.73'),
  usedMargin: usd('9167.30'),
  exposureBySymbol: new Map(exposures.map((e) => [e.symbol, e])),
  openPositionCount: exposures.length,
  limits,
  now: Date.UTC(2026, 7, 21, 9, 27, 56),
  ...over,
});

const engine = new RiskEngine(DEFAULT_RISK_RULES);

describe('RiskEngine', () => {
  it('allows an order that breaks nothing', () => {
    expect(engine.evaluate(order(), context())).toEqual({ allowed: true, violations: [] });
  });

  it('rejects an unconfigured limit as no limit at all', () => {
    // 500 lots with no maxPositionVolume set must still pass the size rules.
    const big = order({ volume: '500', requiredMargin: usd('1'), notional: usd('1') });
    expect(engine.evaluate(big, context()).allowed).toBe(true);
  });

  it('blocks an order with insufficient free margin', () => {
    const decision = engine.evaluate(order(), context({}, { freeMargin: usd('100.00') }));
    expect(decision.allowed).toBe(false);
    expect(decision.violations.map((v) => v.code)).toContain(TradingErrorCode.INSUFFICIENT_MARGIN);
  });

  it('allows an order that consumes exactly the remaining free margin', () => {
    const decision = engine.evaluate(order(), context({}, { freeMargin: usd('4583.65') }));
    expect(decision.allowed).toBe(true);
  });

  it('blocks a disabled instrument', () => {
    const decision = engine.evaluate(order({ spec: { ...XAUUSD, enabled: false } }), context());
    expect(decision.violations.map((v) => v.code)).toContain(TradingErrorCode.SYMBOL_NOT_TRADEABLE);
  });

  it('enforces the per-position volume limit', () => {
    const decision = engine.evaluate(
      order({ volume: '5.00' }),
      context({ maxPositionVolume: '2.00' }),
    );
    expect(decision.violations.map((v) => v.code)).toContain(
      TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
    );
  });

  it('enforces the open position count limit', () => {
    const exposure: SymbolExposure = {
      symbol: 'BTCUSD',
      netVolume: '1',
      grossNotional: usd('77000'),
    };
    const decision = engine.evaluate(order(), context({ maxOpenPositions: 1 }, {}, [exposure]));
    expect(decision.violations.map((v) => v.code)).toContain(
      TradingErrorCode.MAX_OPEN_POSITIONS_EXCEEDED,
    );
  });

  it('nets opposing exposure in the same symbol', () => {
    const short: SymbolExposure = {
      symbol: 'XAUUSD',
      netVolume: '-1.00',
      grossNotional: usd('458365.00'),
    };
    // Buying 1 lot against a 1 lot short takes net exposure to zero.
    const decision = engine.evaluate(order(), context({ maxSymbolNetVolume: '0.50' }, {}, [short]));
    expect(decision.violations.map((v) => v.rule)).not.toContain('max-symbol-net-volume');
  });

  it('blocks an order that would grow net symbol exposure past the limit', () => {
    const long: SymbolExposure = {
      symbol: 'XAUUSD',
      netVolume: '1.00',
      grossNotional: usd('458365.00'),
    };
    const decision = engine.evaluate(order(), context({ maxSymbolNetVolume: '1.50' }, {}, [long]));
    expect(decision.violations.map((v) => v.code)).toContain(
      TradingErrorCode.MAX_EXPOSURE_EXCEEDED,
    );
  });

  it('sums gross notional across symbols including the new order', () => {
    const other: SymbolExposure = {
      symbol: 'BTCUSD',
      netVolume: '2',
      grossNotional: usd('155000.00'),
    };
    const decision = engine.evaluate(order(), context({ maxGrossNotional: '600000' }, {}, [other]));
    expect(decision.violations.map((v) => v.rule)).toContain('max-gross-notional');
  });

  it('reports every violation at once rather than only the first', () => {
    const decision = engine.evaluate(
      order({ volume: '9.00' }),
      context({ maxPositionVolume: '2.00', maxOpenPositions: 0 }, { freeMargin: usd('1.00') }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses to be built with duplicate rule names', () => {
    expect(() => new RiskEngine([...DEFAULT_RISK_RULES, DEFAULT_RISK_RULES[0]!])).toThrow(
      /Duplicate/,
    );
  });

  it('exposes its configured rules for admin display', () => {
    expect(engine.ruleNames()).toContain('sufficient-margin');
  });
});
