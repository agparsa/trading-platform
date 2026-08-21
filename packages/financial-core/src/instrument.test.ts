import { describe, expect, it } from 'vitest';
import {
  assertValidSpec,
  checkVolume,
  InstrumentSpecError,
  normalizePrice,
  normalizeVolume,
  notionalValue,
  tickValue,
} from './instrument';
import { BTCUSD, EURUSD, XAUUSD } from './__fixtures__/instruments';

describe('assertValidSpec', () => {
  it('accepts the shipped instrument specs', () => {
    for (const spec of [XAUUSD, BTCUSD, EURUSD]) {
      expect(() => assertValidSpec(spec)).not.toThrow();
    }
  });

  it('rejects a tick size finer than the stored price precision', () => {
    expect(() => assertValidSpec({ ...XAUUSD, tickSize: '0.0001' })).toThrow(InstrumentSpecError);
  });

  it('rejects a minimum volume that is off the lot step', () => {
    expect(() => assertValidSpec({ ...XAUUSD, minVolume: '0.005' })).toThrow(InstrumentSpecError);
  });

  it('rejects non-positive contract parameters', () => {
    expect(() => assertValidSpec({ ...XAUUSD, contractSize: '0' })).toThrow(InstrumentSpecError);
  });
});

describe('normalization', () => {
  it('snaps prices to the tick grid', () => {
    expect(normalizePrice(XAUUSD, '4583.723').toString()).toBe('4583.72');
    expect(normalizePrice(EURUSD, '1.0875432').toString()).toBe('1.08754');
  });

  it('snaps volume down to the lot step', () => {
    expect(normalizeVolume(XAUUSD, '1.239').toString()).toBe('1.23');
  });
});

describe('checkVolume', () => {
  it('accepts a valid volume', () => {
    expect(checkVolume(XAUUSD, '1.00')).toEqual({ ok: true });
  });

  it('names the specific reason for a rejection', () => {
    expect(checkVolume(XAUUSD, '0').reason).toBe('NOT_POSITIVE');
    expect(checkVolume(XAUUSD, '0.005').reason).toBe('BELOW_MIN');
    expect(checkVolume(XAUUSD, '1000').reason).toBe('ABOVE_MAX');
    expect(checkVolume(XAUUSD, '0.015').reason).toBe('OFF_STEP');
  });
});

describe('notional and tick value', () => {
  // Reference terminal: XAUUSD 1.00 lot at 4583.65 showed exposure $458,365.00.
  it('reproduces the reference terminal exposure figure', () => {
    expect(notionalValue(XAUUSD, '1.00', '4583.65').toString()).toBe('458365');
  });

  it('computes the value of one tick', () => {
    expect(tickValue(XAUUSD, '1.00').toString()).toBe('1');
    expect(tickValue(EURUSD, '1.00').toString()).toBe('1');
  });
});
