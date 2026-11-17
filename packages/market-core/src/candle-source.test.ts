import { describe, expect, it } from 'vitest';
import { CandleAggregator } from './candles';

const at = (ms: number, bid: string, source?: string) => ({
  symbol: 'XAUUSD',
  bid,
  ask: bid,
  timestamp: ms,
  volume: '0',
  ...(source === undefined ? {} : { source }),
});

describe('where a bar’s prices came from', () => {
  it('carries the source of its ticks', () => {
    const bars = new CandleAggregator('XAUUSD', '1');
    bars.push(at(0, '3880.00', 'fastforex'));
    bars.push(at(1_000, '3881.00', 'fastforex'));
    expect(bars.peek()?.source).toBe('fastforex');
  });

  it('is mixed in the bucket where the source changed', () => {
    const bars = new CandleAggregator('XAUUSD', '1');
    bars.push(at(0, '4583.00', 'internal-simulator'));
    bars.push(at(30_000, '3881.00', 'fastforex'));
    expect(bars.peek()?.source).toBe('mixed');
    const closed = bars.push(at(60_000, '3882.00', 'fastforex'));
    expect(closed?.source).toBe('mixed');
    expect(bars.peek()?.source).toBe('fastforex');
  });

  it('says nothing about a source it was not told', () => {
    const bars = new CandleAggregator('XAUUSD', '1');
    bars.push(at(0, '1.00'));
    expect(bars.peek()).not.toHaveProperty('source');
  });
});
