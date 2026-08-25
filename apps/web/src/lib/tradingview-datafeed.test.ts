import { describe, expect, it } from 'vitest';
import {
  barsForRequest,
  datafeedConfiguration,
  periodParamsToWindow,
  priceScaleFor,
  toBar,
  toLibrarySymbolInfo,
  toSessionString,
  type PeriodParams,
} from './tradingview-datafeed';
import type { ChartBar } from './datafeed';
import type { SymbolRow, TradingSession } from './queries';

/**
 * The adapter's mappings.
 *
 * The library itself is licensed and absent, so what can be proven here is the
 * translation: units, price scales, session notation, window arithmetic. Those
 * are also where this integration would fail silently — a chart rendered in 1970
 * or on a grid finer than the instrument trades on looks like a chart until
 * someone reads the axis.
 */

const XAUUSD: SymbolRow = {
  code: 'XAUUSD',
  description: 'Gold vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '5',
  swapLongPerLot: '-2.5',
  swapShortPerLot: '1.2',
  enabled: true,
  sessionOpen: true,
};

const EURUSD: SymbolRow = {
  ...XAUUSD,
  code: 'EURUSD',
  description: 'Euro vs US Dollar',
  contractSize: '100000',
  tickSize: '0.00001',
  pricePrecision: 5,
};

const params = (over: Partial<PeriodParams> = {}): PeriodParams => ({
  from: 1_700_000_000,
  to: 1_700_003_600,
  countBack: 300,
  firstDataRequest: true,
  ...over,
});

describe('priceScaleFor', () => {
  /**
   * `pricescale` is the reciprocal of the displayed increment and `minmov` how
   * many of those one tick spans. Get this wrong and the chart quietly quotes a
   * grid the instrument does not trade on.
   */
  it('derives the scale from the instrument, not a default', () => {
    expect(priceScaleFor(XAUUSD)).toEqual({ pricescale: 100, minmov: 1 });
    expect(priceScaleFor(EURUSD)).toEqual({ pricescale: 100000, minmov: 1 });
  });

  it('handles a tick larger than one displayed increment', () => {
    const fiveCentTicks: SymbolRow = { ...XAUUSD, tickSize: '0.05' };
    expect(priceScaleFor(fiveCentTicks)).toEqual({ pricescale: 100, minmov: 5 });
  });

  it('never returns a zero minmov', () => {
    // A finer tick than the price precision is a bad spec, but a zero minmov
    // makes the library divide by zero rather than draw something wrong.
    const inconsistent: SymbolRow = { ...XAUUSD, tickSize: '0.001' };
    expect(priceScaleFor(inconsistent).minmov).toBeGreaterThan(0);
  });
});

describe('toSessionString', () => {
  const weekday = (day: number) => ({ day, openMinute: 0, closeMinute: 1440 });

  /** Our days are 0=Sunday; the library's are 1=Sunday. Everything shifts by one. */
  it('shifts weekdays into the library’s numbering and collapses identical windows', () => {
    const session: TradingSession = {
      symbol: 'EURUSD',
      timezone: 'UTC',
      windows: [weekday(1), weekday(2), weekday(3), weekday(4), weekday(5)],
    };
    expect(toSessionString(session)).toBe('0000-2400:23456');
  });

  it('keeps distinct windows as separate segments', () => {
    const session: TradingSession = {
      symbol: 'XAUUSD',
      timezone: 'UTC',
      windows: [
        { day: 1, openMinute: 60, closeMinute: 480 },
        { day: 2, openMinute: 0, closeMinute: 1440 },
      ],
    };
    expect(toSessionString(session)).toBe('0100-0800:2|0000-2400:3');
  });

  it('describes an instrument with no windows as never closing rather than never opening', () => {
    // An empty window list means the seed did not configure one. '24x7' is the
    // library's own default and shows every bar; an empty session string makes
    // it discard all of them, which reads as a broken feed.
    expect(toSessionString({ symbol: 'BTCUSD', timezone: 'UTC', windows: [] })).toBe('24x7');
  });
});

describe('toLibrarySymbolInfo', () => {
  it('carries the instrument’s own precision and session timezone', () => {
    const session: TradingSession = {
      symbol: 'XAUUSD',
      timezone: 'Europe/London',
      windows: [{ day: 1, openMinute: 0, closeMinute: 1440 }],
    };
    const info = toLibrarySymbolInfo(XAUUSD, session);
    expect(info.ticker).toBe('XAUUSD');
    expect(info.pricescale).toBe(100);
    expect(info.timezone).toBe('Europe/London');
    expect(info.session).toBe('0000-2400:2');
    expect(info.has_intraday).toBe(true);
  });

  it('falls back to UTC when the session is unknown', () => {
    expect(toLibrarySymbolInfo(XAUUSD, null).timezone).toBe('Etc/UTC');
  });
});

describe('periodParamsToWindow', () => {
  /**
   * The unit trap. `PeriodParams` is in seconds and `Bar.time` in milliseconds —
   * verified against TradingView's own `charting-library-tutorial`, whose
   * `getBars` multiplies `periodParams.to` by 1000. Mixing them renders every
   * bar in 1970.
   */
  it('converts seconds to milliseconds', () => {
    const { toMs } = periodParamsToWindow(params({ to: 1_700_003_600 }), '1');
    expect(toMs).toBe(1_700_003_600_000);
  });

  /** countBack outranks `from`: returning fewer bars makes the library ask again. */
  it('sizes the window by countBack when it reaches further back than from', () => {
    const { fromMs, toMs } = periodParamsToWindow(
      params({ from: 1_700_003_000, to: 1_700_003_600, countBack: 300 }),
      '1',
    );
    expect(toMs - fromMs).toBe(300 * 60_000);
  });

  it('honours from when it reaches further back than countBack', () => {
    const { fromMs } = periodParamsToWindow(
      params({ from: 1_600_000_000, to: 1_700_003_600, countBack: 10 }),
      '1',
    );
    expect(fromMs).toBe(1_600_000_000_000);
  });

  it('never asks for a zero-width window', () => {
    const { fromMs, toMs } = periodParamsToWindow(
      params({ from: 1_700_003_600, to: 1_700_003_600, countBack: 0 }),
      '1',
    );
    expect(toMs - fromMs).toBeGreaterThan(0);
  });
});

describe('barsForRequest', () => {
  const candle = (time: number): ChartBar => ({
    time,
    open: '1',
    high: '2',
    low: '0.5',
    close: '1.5',
    volume: '3',
  });

  /** `to` is exclusive; returning that bar would draw it in two pages. */
  it('excludes the bar opening exactly on `to`', () => {
    const bars = barsForRequest(
      [candle(1_700_003_540_000), candle(1_700_003_600_000)],
      params({ to: 1_700_003_600 }),
    );
    expect(bars.map((b) => b.time)).toEqual([1_700_003_540_000]);
  });

  it('returns bars oldest first', () => {
    const bars = barsForRequest(
      [candle(1_700_000_120_000), candle(1_700_000_000_000), candle(1_700_000_060_000)],
      params({ to: 1_700_003_600 }),
    );
    expect(bars.map((b) => b.time)).toEqual([
      1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000,
    ]);
  });

  it('leaves bar times in milliseconds', () => {
    const bars = barsForRequest([candle(1_700_000_000_000)], params());
    expect(bars[0]?.time).toBe(1_700_000_000_000);
  });
});

describe('toBar', () => {
  it('turns decimal strings into numbers only at the rendering boundary', () => {
    const bar = toBar({
      time: 1_700_000_000_000,
      open: '4583.72',
      high: '4590.01',
      low: '4580.10',
      close: '4585.55',
      volume: '128',
    });
    expect(bar).toEqual({
      time: 1_700_000_000_000,
      open: 4583.72,
      high: 4590.01,
      low: 4580.1,
      close: 4585.55,
      volume: 128,
    });
  });
});

describe('datafeedConfiguration', () => {
  it('advertises exactly the resolutions the server aggregates', () => {
    expect(datafeedConfiguration().supported_resolutions).toEqual([
      '1',
      '5',
      '15',
      '60',
      '240',
      '1D',
    ]);
  });

  /**
   * Marks are event annotations. The data for them exists, but advertising
   * support for a callback that returns nothing would show the library an
   * empty feature rather than an absent one.
   */
  it('does not claim support for features that are not implemented', () => {
    const config = datafeedConfiguration();
    expect(config.supports_marks).toBe(false);
    expect(config.supports_timescale_marks).toBe(false);
  });
});
