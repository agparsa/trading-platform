import type { SymbolSpec } from '@tp/financial-core';

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
