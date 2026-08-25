import {
  RESOLUTIONS,
  mergeBars,
  resolutionMs,
  type ChartBar,
  type ChartDatafeed,
} from './datafeed';
import type { SymbolRow, TradingSession } from './queries';

/**
 * TradingView Advanced Charts adapter.
 *
 * **Status: the mappings below are implemented and tested; the widget itself is
 * not, because the library is licensed and not present in this repository.**
 *
 * The contract was taken from TradingView's published documentation and from
 * their own `charting-library-tutorial` repository, not from memory. Two units
 * differ and are the classic source of a chart that renders in 1970:
 *
 *   - `PeriodParams.from` / `.to` are **seconds**
 *   - `Bar.time` is **milliseconds**
 *
 * Both are verified against the tutorial's `getBars`, which multiplies
 * `periodParams.to` by 1000 before comparing it with bar times.
 *
 * The types here are declared by hand. The real ones ship inside the licensed
 * bundle, so importing them is impossible until it is unpacked into
 * `apps/web/public/charting_library/`. When it is, delete these declarations and
 * import `IDatafeedChartApi` — the shapes are deliberately identical, so the
 * compiler will confirm the mapping rather than the author's memory.
 */

// --- Hand-declared subset of the library's types -------------------------

export interface LibrarySymbolInfo {
  ticker: string;
  name: string;
  full_name: string;
  description: string;
  type: string;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: 'price';
  minmov: number;
  pricescale: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: string[];
  volume_precision: number;
  data_status: 'streaming' | 'endofday' | 'delayed_streaming';
}

export interface PeriodParams {
  /** Unix timestamp in **seconds**, inclusive. */
  from: number;
  /** Unix timestamp in **seconds**, exclusive. */
  to: number;
  /** Bars the library needs. Outranks `from`. */
  countBack: number;
  firstDataRequest: boolean;
}

export interface Bar {
  /** Bar open time, UTC **milliseconds**. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface DatafeedConfiguration {
  supported_resolutions: string[];
  supports_marks: boolean;
  supports_timescale_marks: boolean;
  supports_time: boolean;
  supports_search: boolean;
  exchanges: Array<{ value: string; name: string; desc: string }>;
  symbols_types: Array<{ name: string; value: string }>;
}

const EXCHANGE = 'Trading Platform';

// --- Pure mappings -------------------------------------------------------

export function datafeedConfiguration(): DatafeedConfiguration {
  return {
    supported_resolutions: [...RESOLUTIONS],
    // Marks are event annotations on the time scale. The platform has the data
    // for them — executions, breaches — but wiring them before the library can
    // be run would be claiming a feature nobody has seen work.
    supports_marks: false,
    supports_timescale_marks: false,
    supports_time: true,
    supports_search: true,
    exchanges: [{ value: EXCHANGE, name: EXCHANGE, desc: EXCHANGE }],
    symbols_types: [{ name: 'All', value: '' }],
  };
}

/**
 * Price scale, the library's way.
 *
 * `pricescale` is the reciprocal of the smallest displayed increment, and
 * `minmov` is how many of those increments one tick spans. For an instrument
 * quoted to five decimals in whole pips, that is 100000 and 1; for gold quoted
 * to two decimals in whole cents, 100 and 1. Deriving both from the instrument's
 * own spec keeps the chart's grid identical to the engine's tick grid.
 */
export function priceScaleFor(spec: SymbolRow): { pricescale: number; minmov: number } {
  const pricescale = 10 ** spec.pricePrecision;
  const minmov = Math.max(1, Math.round(Number(spec.tickSize) * pricescale));
  return { pricescale, minmov };
}

/**
 * Session windows in the library's notation: `HHMM-HHMM:days`, days being
 * 1=Sunday..7=Saturday, segments joined by `|`.
 *
 * Our windows are 0=Sunday..6=Saturday, so every day shifts by one. Windows
 * sharing the same open and close are collapsed into one segment, which is how
 * a Monday-to-Friday instrument becomes `0000-2400:23456` rather than five
 * identical segments.
 */
export function toSessionString(session: TradingSession): string {
  if (session.windows.length === 0) return '24x7';

  const byTimes = new Map<string, number[]>();
  for (const window of session.windows) {
    const key = `${minutesToHhmm(window.openMinute)}-${minutesToHhmm(window.closeMinute)}`;
    const days = byTimes.get(key) ?? [];
    // 0=Sunday here, 1=Sunday there.
    days.push(window.day + 1);
    byTimes.set(key, days);
  }

  return [...byTimes.entries()]
    .map(([times, days]) => `${times}:${[...days].sort((a, b) => a - b).join('')}`)
    .join('|');
}

function minutesToHhmm(minute: number): string {
  // 1440 is midnight at the *end* of the day, which the library writes as 2400.
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
}

export function toLibrarySymbolInfo(
  spec: SymbolRow,
  session: TradingSession | null,
): LibrarySymbolInfo {
  const { pricescale, minmov } = priceScaleFor(spec);
  return {
    ticker: spec.code,
    name: spec.code,
    full_name: `${EXCHANGE}:${spec.code}`,
    description: spec.description,
    type: 'cfd',
    session: session === null ? '24x7' : toSessionString(session),
    timezone: session?.timezone ?? 'Etc/UTC',
    exchange: EXCHANGE,
    listed_exchange: EXCHANGE,
    format: 'price',
    minmov,
    pricescale,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: false,
    supported_resolutions: [...RESOLUTIONS],
    volume_precision: spec.volumePrecision,
    data_status: 'streaming',
  };
}

/**
 * One of our bars, as the library wants it.
 *
 * Prices become JS numbers here and nowhere else. That is safe because a chart
 * coordinate is not money — but it is a one-way door, so it happens at the
 * boundary rather than anywhere a value could flow back into an order.
 */
export function toBar(candle: ChartBar): Bar {
  return {
    time: candle.time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume),
  };
}

/**
 * The millisecond window to fetch for a `getBars` request.
 *
 * `countBack` outranks `from`: the library states how many bars it needs, and
 * returning fewer makes it ask again for the shortfall. So the window is sized
 * by `countBack` back from `to`, and `from` is only a floor when it reaches
 * further back than that.
 */
export function periodParamsToWindow(
  periodParams: PeriodParams,
  resolution: string,
): { fromMs: number; toMs: number } {
  const toMs = periodParams.to * 1000;
  const span = resolutionMs(resolution);
  const byCount = toMs - Math.max(1, periodParams.countBack) * span;
  const byFrom = periodParams.from * 1000;
  return { fromMs: Math.min(byCount, byFrom), toMs };
}

/**
 * Bars inside the requested window, newest last.
 *
 * The bar opening exactly on `to` belongs to the *next* request: `to` is
 * exclusive, and returning it would draw the same bar in two pages.
 */
export function barsForRequest(candles: readonly ChartBar[], periodParams: PeriodParams): Bar[] {
  const toMs = periodParams.to * 1000;
  return candles
    .filter((candle) => candle.time < toMs)
    .sort((a, b) => a.time - b.time)
    .map(toBar);
}

// --- The datafeed object -------------------------------------------------

type HistoryCallback = (bars: Bar[], meta: { noData: boolean }) => void;
type ErrorCallback = (reason: string) => void;
type SubscribeBarsCallback = (bar: Bar) => void;

export interface LiveBarSource {
  /** Calls back with every bar the server publishes for this symbol/resolution. */
  subscribe(symbol: string, resolution: string, onBar: (bar: ChartBar) => void): () => void;
}

export interface PlatformDatafeedDeps {
  readonly datafeed: ChartDatafeed;
  readonly symbols: () => readonly SymbolRow[];
  readonly sessionFor: (code: string) => TradingSession | null;
  readonly live: LiveBarSource;
  readonly serverTimeSeconds: () => number;
}

/**
 * Builds the object the library is handed as its datafeed.
 *
 * Every method here delegates to a mapping above, so the part that can be tested
 * without the library is tested, and the part that cannot is a thin shell. When
 * the licensed bundle lands, this is what gets passed to `new TradingView.widget`
 * — see `docs/charting.md`.
 */
export function createTradingViewDatafeed(deps: PlatformDatafeedDeps) {
  const unsubscribes = new Map<string, () => void>();

  return {
    onReady: (callback: (config: DatafeedConfiguration) => void): void => {
      // The library requires this to be asynchronous.
      setTimeout(() => callback(datafeedConfiguration()), 0);
    },

    searchSymbols: (
      userInput: string,
      _exchange: string,
      _symbolType: string,
      onResult: (results: Array<Record<string, string>>) => void,
    ): void => {
      const needle = userInput.trim().toUpperCase();
      onResult(
        deps
          .symbols()
          .filter(
            (symbol) =>
              needle === '' ||
              symbol.code.includes(needle) ||
              symbol.description.toUpperCase().includes(needle),
          )
          .map((symbol) => ({
            symbol: symbol.code,
            full_name: `${EXCHANGE}:${symbol.code}`,
            description: symbol.description,
            exchange: EXCHANGE,
            ticker: symbol.code,
            type: 'cfd',
          })),
      );
    },

    resolveSymbol: (
      symbolName: string,
      onResolved: (info: LibrarySymbolInfo) => void,
      onError: ErrorCallback,
    ): void => {
      const code = symbolName.includes(':') ? symbolName.split(':')[1]! : symbolName;
      const spec = deps.symbols().find((symbol) => symbol.code === code.toUpperCase());
      if (spec === undefined) {
        onError('unknown_symbol');
        return;
      }
      setTimeout(() => onResolved(toLibrarySymbolInfo(spec, deps.sessionFor(spec.code))), 0);
    },

    getBars: async (
      symbolInfo: LibrarySymbolInfo,
      resolution: string,
      periodParams: PeriodParams,
      onHistory: HistoryCallback,
      onError: ErrorCallback,
    ): Promise<void> => {
      try {
        const { fromMs, toMs } = periodParamsToWindow(periodParams, resolution);
        const candles = await deps.datafeed.history(symbolInfo.ticker, resolution, fromMs, toMs);
        const bars = barsForRequest(candles, periodParams);
        // `noData` tells the library to stop paging backwards. Reporting it on a
        // page that merely came back short would truncate the history.
        onHistory(bars, { noData: bars.length === 0 });
      } catch (error) {
        onError(error instanceof Error ? error.message : 'Failed to load bars');
      }
    },

    subscribeBars: (
      symbolInfo: LibrarySymbolInfo,
      resolution: string,
      onTick: SubscribeBarsCallback,
      subscriberUID: string,
    ): void => {
      unsubscribes.get(subscriberUID)?.();
      unsubscribes.set(
        subscriberUID,
        deps.live.subscribe(symbolInfo.ticker, resolution, (bar) => onTick(toBar(bar))),
      );
    },

    unsubscribeBars: (subscriberUID: string): void => {
      unsubscribes.get(subscriberUID)?.();
      unsubscribes.delete(subscriberUID);
    },

    getServerTime: (callback: (seconds: number) => void): void => {
      callback(deps.serverTimeSeconds());
    },
  };
}

export { mergeBars };
