import { describe, expect, it } from 'vitest';
import { mergeBars } from './bars';
import type { CandleRow } from './queries';

const bar = (time: number, close: string): CandleRow => ({
  symbol: 'XAUUSD',
  resolution: '1',
  time,
  open: '2000',
  high: '2001',
  low: '1999',
  close,
  volume: '10',
});

describe('mergeBars', () => {
  it('returns the history when nothing is live', () => {
    expect(mergeBars([bar(1, '1'), bar(2, '2')], undefined).map((b) => b.time)).toEqual([1, 2]);
  });

  it('lets a live bar replace the stored bar for the same bucket', () => {
    const merged = mergeBars([bar(1, 'stale')], { 1: bar(1, 'fresh') });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.close).toBe('fresh');
  });

  it('appends a live bar the history has not caught up with', () => {
    const merged = mergeBars([bar(1, 'a')], { 2: bar(2, 'b') });
    expect(merged.map((b) => b.time)).toEqual([1, 2]);
  });

  it('sorts by time regardless of arrival order', () => {
    const merged = mergeBars([bar(3, 'c'), bar(1, 'a')], { 2: bar(2, 'b') });
    expect(merged.map((b) => b.time)).toEqual([1, 2, 3]);
  });

  it('never yields two bars for one bucket', () => {
    const merged = mergeBars([bar(1, 'a'), bar(1, 'a')], { 1: bar(1, 'live') });
    expect(merged).toHaveLength(1);
  });
});
