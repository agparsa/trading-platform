import { describe, expect, it } from 'vitest';
import { liveBarFor } from './live-candle';

const watch = { symbol: 'XAUUSD', resolution: '15' };
const frame = {
  symbol: 'XAUUSD',
  resolution: '15',
  time: 1_795_860_000_000,
  open: '4582.10',
  high: '4583.00',
  low: '4581.90',
  close: '4582.44',
  volume: '12',
  closed: false,
};

describe('liveBarFor', () => {
  it('draws the in-progress bar of the chart on screen', () => {
    expect(liveBarFor(frame, watch)).toEqual({
      time: 1_795_860_000_000,
      open: '4582.10',
      high: '4583.00',
      low: '4581.90',
      close: '4582.44',
      volume: '12',
    });
  });

  it('ignores another instrument or timeframe, and no chart at all', () => {
    expect(liveBarFor({ ...frame, symbol: 'EURUSD' }, watch)).toBeNull();
    expect(liveBarFor({ ...frame, resolution: '1' }, watch)).toBeNull();
    expect(liveBarFor(frame, null)).toBeNull();
  });

  it('refuses a malformed frame rather than drawing it', () => {
    expect(liveBarFor({ ...frame, close: 'NaN' }, watch)).toBeNull();
    expect(liveBarFor({ ...frame, time: '1795860000000' }, watch)).toBeNull();
    expect(liveBarFor(null, watch)).toBeNull();
  });
});
