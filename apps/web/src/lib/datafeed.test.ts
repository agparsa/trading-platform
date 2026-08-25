import { describe, expect, it } from 'vitest';
import { barWindow, mergeBars, resolutionMs, type ChartBar } from './datafeed';

const bar = (time: number, close: string): ChartBar => ({
  time,
  open: '2000',
  high: '2001',
  low: '1999',
  close,
  volume: '10',
});

describe('resolutionMs', () => {
  it('maps every supported resolution', () => {
    expect(resolutionMs('1')).toBe(60_000);
    expect(resolutionMs('15')).toBe(900_000);
    expect(resolutionMs('240')).toBe(14_400_000);
    expect(resolutionMs('1D')).toBe(86_400_000);
  });

  it('falls back to one minute rather than zero', () => {
    // A zero span would divide by zero in barWindow and produce an infinite
    // window — a wrong chart is better than a hung request.
    expect(resolutionMs('nonsense')).toBe(60_000);
  });
});

describe('barWindow', () => {
  /**
   * The window must not move between renders. An unsnapped `to` changes every
   * millisecond, which changes the query key, which refetches the series
   * continuously — polling by accident.
   */
  // An exact multiple of one minute, so the arithmetic below is readable.
  const BOUNDARY = 1_700_000_040_000;

  it('snaps to the bar boundary so the window is stable within a bar', () => {
    const early = barWindow('1', 100, BOUNDARY + 1);
    const late = barWindow('1', 100, BOUNDARY + 59_999);
    expect(early).toEqual(late);
    expect(early.toMs).toBe(BOUNDARY + 60_000);
  });

  it('moves on when the bar does', () => {
    const before = barWindow('1', 100, BOUNDARY + 1);
    const after = barWindow('1', 100, BOUNDARY + 60_001);
    expect(after.toMs).toBe(before.toMs + 60_000);
  });

  it('spans exactly the requested number of bars', () => {
    const { fromMs, toMs } = barWindow('15', 40, 1_700_000_000_000);
    expect(toMs - fromMs).toBe(40 * 15 * 60_000);
  });
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
    expect(mergeBars([bar(1, 'a')], { 2: bar(2, 'b') }).map((b) => b.time)).toEqual([1, 2]);
  });

  it('sorts by time regardless of arrival order', () => {
    const merged = mergeBars([bar(3, 'c'), bar(1, 'a')], { 2: bar(2, 'b') });
    expect(merged.map((b) => b.time)).toEqual([1, 2, 3]);
  });

  it('never yields two bars for one bucket', () => {
    expect(mergeBars([bar(1, 'a'), bar(1, 'a')], { 1: bar(1, 'live') })).toHaveLength(1);
  });
});
