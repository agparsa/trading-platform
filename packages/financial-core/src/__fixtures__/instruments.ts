import type { SymbolSpec } from '../instrument';

/**
 * Contract specifications used across the financial test suite.
 *
 * The XAUUSD and BTCUSD numbers are reverse-engineered from a real broker
 * terminal session (see `docs/pnl.md`, "Reference vectors"): every expected
 * value in `pnl.test.ts` is a figure that terminal actually displayed, so these
 * tests check our arithmetic against production behaviour rather than against
 * our own assumptions.
 */
export const XAUUSD: SymbolSpec = {
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

export const BTCUSD: SymbolSpec = {
  code: 'BTCUSD',
  description: 'Bitcoin vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '1',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '0',
  swapLongPerLot: '0',
  swapShortPerLot: '0',
  enabled: true,
};

export const EURUSD: SymbolSpec = {
  code: 'EURUSD',
  description: 'Euro vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '100000',
  tickSize: '0.00001',
  pricePrecision: 5,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '200',
  marginRate: '0.002',
  commissionPerLot: '3.5',
  swapLongPerLot: '-2.1',
  swapShortPerLot: '0.4',
  enabled: true,
};

/** Same currency on both sides — the conversion rate is exactly 1. */
export const NO_CONVERSION = '1';
