import { describe, expect, it } from 'vitest';
import { aggregateTicks, bucketStart, CandleAggregator } from './candles';
import { Resolution } from './types';
import { T0, tick } from './__fixtures__/market';

const MIN = 60_000;

describe('bucketStart', () => {
  it('aligns to the resolution grid, not to the first tick', () => {
    expect(bucketStart(T0 + 137_000, Resolution.M1)).toBe(T0 + 2 * MIN);
    expect(bucketStart(T0 + 137_000, Resolution.M5)).toBe(T0);
    expect(bucketStart(T0 + 301_000, Resolution.M5)).toBe(T0 + 5 * MIN);
  });
});

describe('CandleAggregator', () => {
  it('builds OHLCV from the bid side', () => {
    const agg = new CandleAggregator('XAUUSD', Resolution.M1);
    expect(agg.push(tick(0, '4583.65', '4583.79'))).toBeNull();
    agg.push(tick(10_000, '4585.00', '4585.14'));
    agg.push(tick(20_000, '4580.00', '4580.14'));
    agg.push(tick(30_000, '4584.00', '4584.14'));

    const open = agg.peek();
    expect(open).not.toBeNull();
    expect(open?.open).toBe('4583.65');
    expect(open?.high).toBe('4585');
    expect(open?.low).toBe('4580');
    expect(open?.close).toBe('4584');
    expect(open?.volume).toBe('4');
  });

  it('returns the completed candle when a tick opens the next bucket', () => {
    const agg = new CandleAggregator('XAUUSD', Resolution.M1);
    agg.push(tick(0, '4583.65', '4583.79'));
    agg.push(tick(30_000, '4590.00', '4590.14'));
    const closed = agg.push(tick(61_000, '4600.00', '4600.14'));

    expect(closed).not.toBeNull();
    expect(closed?.time).toBe(T0);
    expect(closed?.close).toBe('4590');
    expect(agg.peek()?.time).toBe(T0 + MIN);
    expect(agg.peek()?.open).toBe('4600');
  });

  it('ignores an out-of-order tick rather than corrupting the candle', () => {
    const agg = new CandleAggregator('XAUUSD', Resolution.M1);
    agg.push(tick(61_000, '4600.00', '4600.14'));
    expect(agg.push(tick(10_000, '4000.00', '4000.14'))).toBeNull();
    expect(agg.peek()?.low).toBe('4600');
  });

  it('refuses ticks for a different symbol', () => {
    const agg = new CandleAggregator('XAUUSD', Resolution.M1);
    expect(() => agg.push({ ...tick(0, '1', '2'), symbol: 'BTCUSD' })).toThrow(/received a BTCUSD/);
  });

  it('flushes the in-progress bucket exactly once', () => {
    const agg = new CandleAggregator('XAUUSD', Resolution.M1);
    agg.push(tick(0, '4583.65', '4583.79'));
    expect(agg.flush()).not.toBeNull();
    expect(agg.flush()).toBeNull();
  });
});

describe('aggregateTicks', () => {
  it('emits one candle per populated bucket, including the last partial one', () => {
    const ticks = Array.from({ length: 7 }, (_, i) =>
      tick(i * 30_000, `${4580 + i}.00`, `${4580 + i}.14`),
    );
    const candles = aggregateTicks('XAUUSD', Resolution.M1, ticks);
    expect(candles.map((c) => c.time)).toEqual([T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN]);
    expect(candles[0]?.open).toBe('4580');
    expect(candles[0]?.close).toBe('4581');
  });
});
