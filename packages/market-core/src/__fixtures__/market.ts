import type { SymbolSpec } from '@tp/financial-core';
import type { InstrumentDefinition, Tick, TradingSession } from '../types';
import type { SimulatedInstrument } from '../providers/simulator';

export const XAUUSD_SPEC: SymbolSpec = {
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

/** Sunday 22:00 UTC to Friday 21:00 UTC, the usual metals week. */
export const METALS_SESSION: TradingSession = {
  symbol: 'XAUUSD',
  timezone: 'UTC',
  windows: [
    { day: 0, openMinute: 22 * 60, closeMinute: 24 * 60 },
    { day: 1, openMinute: 0, closeMinute: 24 * 60 },
    { day: 2, openMinute: 0, closeMinute: 24 * 60 },
    { day: 3, openMinute: 0, closeMinute: 24 * 60 },
    { day: 4, openMinute: 0, closeMinute: 24 * 60 },
    { day: 5, openMinute: 0, closeMinute: 21 * 60 },
  ],
};

export const XAUUSD_INSTRUMENT: InstrumentDefinition = {
  spec: XAUUSD_SPEC,
  session: METALS_SESSION,
};

export const XAUUSD_SIMULATED: SimulatedInstrument = {
  definition: XAUUSD_INSTRUMENT,
  startPrice: '4583.65',
  volatility: 0.0002,
  baseHalfSpread: '0.07',
  tickIntervalMs: 250,
};

/** 2026-08-21T09:00:00.000Z — the day the reference terminal capture was taken. */
export const T0 = Date.UTC(2026, 7, 21, 9, 0, 0);

export function tick(offsetMs: number, bid: string, ask: string, volume = '1'): Tick {
  return { symbol: 'XAUUSD', bid, ask, timestamp: T0 + offsetMs, volume };
}
