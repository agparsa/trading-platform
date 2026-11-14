import { describe, expect, it } from 'vitest';
import {
  TickThrottle,
  parseSymbolMap,
  isFastForexMetal,
  ticksFromFastForexQuotes,
  tickFromBinanceBookTicker,
  tickFromOandaPrice,
  tickFromTwelveDataPrice,
} from './live-quotes';

const precision = (code: string) => ({ BTCUSD: 2, EURUSD: 5, XAUUSD: 2 })[code];
const NOW = 1_800_000_000_000;

describe('parseSymbolMap', () => {
  it('reads platform code first and keeps the venue symbol as written', () => {
    expect(parseSymbolMap('BTCUSD:btcusdt, EURUSD:EUR/USD,,bad')).toEqual({
      btcusdt: 'BTCUSD',
      'EUR/USD': 'EURUSD',
    });
  });
});

describe('a Binance book ticker', () => {
  const map = parseSymbolMap('BTCUSD:btcusdt');
  // The payload exactly as the stream documentation gives it.
  const frame = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      stream: 'btcusdt@bookTicker',
      data: {
        u: 400900217,
        s: 'BTCUSDT',
        b: '77634.99000000',
        B: '1.2',
        a: '77635.01000000',
        A: '3',
        ...over,
      },
    });

  it("becomes the platform's tick at the instrument's precision", () => {
    expect(tickFromBinanceBookTicker(frame(), map, precision, NOW)).toEqual({
      symbol: 'BTCUSD',
      bid: '77634.99',
      ask: '77635.01',
      timestamp: NOW,
      volume: '0',
    });
  });

  it('rounds the bid down and the ask up, so rounding never crosses the book', () => {
    const tick = tickFromBinanceBookTicker(
      frame({ b: '77634.998', a: '77634.999' }),
      map,
      precision,
      NOW,
    );
    expect(tick).toMatchObject({ bid: '77634.99', ask: '77635.00' });
  });

  it('is nothing for an instrument it was not told to follow, or a price that is not one', () => {
    expect(tickFromBinanceBookTicker(frame({ s: 'DOGEUSDT' }), map, precision, NOW)).toBeNull();
    expect(tickFromBinanceBookTicker(frame({ b: '0' }), map, precision, NOW)).toBeNull();
    expect(tickFromBinanceBookTicker(frame({ a: 'NaN' }), map, precision, NOW)).toBeNull();
    expect(
      tickFromBinanceBookTicker(frame({ b: '77636', a: '77635' }), map, precision, NOW),
    ).toBeNull();
    expect(tickFromBinanceBookTicker('not json', map, precision, NOW)).toBeNull();
  });
});

describe('a Twelve Data price event', () => {
  const map = parseSymbolMap('XAUUSD:XAU/USD,EURUSD:EUR/USD');
  const half = (code: string) => ({ EURUSD: '0.00004' })[code];

  it('uses the bid and ask when the venue sends them', () => {
    const raw = JSON.stringify({
      event: 'price',
      symbol: 'XAU/USD',
      timestamp: NOW / 1000 - 1,
      price: 4018.57,
      bid: 4018.47,
      ask: 4018.68,
    });
    expect(tickFromTwelveDataPrice(raw, map, precision, half, NOW)).toEqual({
      symbol: 'XAUUSD',
      bid: '4018.47',
      ask: '4018.68',
      timestamp: NOW - 1000,
      volume: '0',
    });
  });

  it("quotes the platform's own spread around a price that came alone", () => {
    const raw = JSON.stringify({
      event: 'price',
      symbol: 'EUR/USD',
      timestamp: NOW / 1000,
      price: 1.11549,
    });
    expect(tickFromTwelveDataPrice(raw, map, precision, half, NOW)).toMatchObject({
      symbol: 'EURUSD',
      bid: '1.11545',
      ask: '1.11553',
    });
  });

  it('is nothing without a spread to quote, for another event, or an unknown symbol', () => {
    const alone = JSON.stringify({ event: 'price', symbol: 'XAU/USD', price: 4018.57 });
    expect(tickFromTwelveDataPrice(alone, map, precision, half, NOW)).toBeNull();
    const status = JSON.stringify({ event: 'subscribe-status', status: 'ok' });
    expect(tickFromTwelveDataPrice(status, map, precision, half, NOW)).toBeNull();
    const other = JSON.stringify({ event: 'price', symbol: 'AAPL', price: 1 });
    expect(tickFromTwelveDataPrice(other, map, precision, half, NOW)).toBeNull();
  });

  it('never dates a tick in the future', () => {
    const raw = JSON.stringify({
      event: 'price',
      symbol: 'XAU/USD',
      timestamp: NOW / 1000 + 60,
      bid: 1,
      ask: 2,
    });
    expect(tickFromTwelveDataPrice(raw, map, precision, half, NOW)?.timestamp).toBe(NOW);
  });
});

describe('TickThrottle', () => {
  it('lets one tick an instrument through per interval, each instrument on its own', () => {
    const throttle = new TickThrottle(250);
    const at = (symbol: string, timestamp: number) =>
      throttle.admit({ symbol, bid: '1', ask: '2', timestamp, volume: '0' });
    expect(at('BTCUSD', 1000)).toBe(true);
    expect(at('BTCUSD', 1100)).toBe(false);
    expect(at('ETHUSD', 1100)).toBe(true);
    expect(at('BTCUSD', 1250)).toBe(true);
  });
});

describe('OANDA v20 pricing stream', () => {
  const symbols = { XAU_USD: 'XAUUSD', EUR_USD: 'EURUSD' };
  const precision = (code: string) => ({ XAUUSD: 2, EURUSD: 5 })[code];
  const NOW = Date.parse('2016-09-20T15:06:00.000Z');
  // The line the documentation shows, verbatim.
  const DOCUMENTED =
    '{"asks":[{"liquidity":10000000,"price":"1.11704"},{"liquidity":10000000,"price":"1.11706"}],"bids":[{"liquidity":10000000,"price":"1.11690"},{"liquidity":10000000,"price":"1.11688"}],"closeoutAsk":"1.11708","closeoutBid":"1.11686","instrument":"EUR_USD","status":"tradeable","time":"2016-09-20T15:05:47.960449532Z"}';

  it('takes the top of the book from the documented line, at its own time', () => {
    expect(tickFromOandaPrice(DOCUMENTED, symbols, precision, NOW)).toEqual({
      symbol: 'EURUSD',
      bid: '1.11690',
      ask: '1.11704',
      timestamp: Date.parse('2016-09-20T15:05:47.960Z'),
      volume: '0',
    });
  });

  it('is nothing for a heartbeat, an unmapped instrument or a non-tradeable price', () => {
    expect(
      tickFromOandaPrice(
        '{"time":"2016-09-20T15:05:50.163791738Z","type":"HEARTBEAT"}',
        symbols,
        precision,
        NOW,
      ),
    ).toBeNull();
    expect(
      tickFromOandaPrice(DOCUMENTED.replace('EUR_USD', 'GBP_USD'), symbols, precision, NOW),
    ).toBeNull();
    expect(
      tickFromOandaPrice(
        DOCUMENTED.replace('"status":"tradeable"', '"status":"non-tradeable"'),
        symbols,
        precision,
        NOW,
      ),
    ).toBeNull();
    expect(
      tickFromOandaPrice(
        DOCUMENTED.replace('"status":"tradeable"', '"tradeable":false'),
        symbols,
        precision,
        NOW,
      ),
    ).toBeNull();
    expect(
      tickFromOandaPrice('{"instrument":"EUR_USD","bids":[],"asks":[]}', symbols, precision, NOW),
    ).toBeNull();
  });

  it('never dates a price after now', () => {
    const later = DOCUMENTED.replace('2016-09-20T15:05:47', '2016-09-20T16:00:00');
    expect(tickFromOandaPrice(later, symbols, precision, NOW)?.timestamp).toBe(NOW);
  });
});

describe('fastFOREX quotes', () => {
  const symbols = { EURUSD: 'EURUSD', USDJPY: 'USDJPY', XAUUSD: 'XAUUSD', XAGUSD: 'XAGUSD' };
  const precision = (code: string) => ({ EURUSD: 5, USDJPY: 3, XAUUSD: 2, XAGUSD: 3 })[code];
  const NOW = 1_794_614_000_000;
  // As the live API answered on 14 Nov 2026.
  const FX =
    '{"quotes":{"EURUSD":{"bid":"1.10214","ask":"1.1025","tsp":"1794613872987","size":1},"USDJPY":{"bid":"159.688","ask":"159.755","tsp":"1794613907476","size":1}},"ms":3}';
  const METALS =
    '{"quotes":{"XAUUSD":{"bid":"3881.93","ask":"3886.08","mid":"3884.01","spread":"4.15","tsp":1794607199966,"dtm":"2026-11-13T21:59:59Z","metal":"XAU","target":"USD","unit":"oz_t","purity":"1000","cross_rate":false}},"source":"otc_aggregate","ms":6}';

  it('turns each bid/ask quote into a tick at the source time', () => {
    expect(ticksFromFastForexQuotes(FX, symbols, precision, NOW)).toEqual([
      { symbol: 'EURUSD', bid: '1.10214', ask: '1.10250', timestamp: 1794613872987, volume: '0' },
      { symbol: 'USDJPY', bid: '159.688', ask: '159.755', timestamp: 1794613907476, volume: '0' },
    ]);
    expect(ticksFromFastForexQuotes(METALS, symbols, precision, NOW)).toEqual([
      { symbol: 'XAUUSD', bid: '3881.93', ask: '3886.08', timestamp: 1794607199966, volume: '0' },
    ]);
  });

  it('never makes a dealing price from a midpoint, or from a quote with no ask', () => {
    const midOnly =
      '{"base":"USD","results":{"EUR":0.907178},"updated":"2026-11-13T23:51:47Z","ms":4}';
    expect(ticksFromFastForexQuotes(midOnly, symbols, precision, NOW)).toEqual([]);
    const noAsk = '{"quotes":{"XAGUSD":{"bid":"48.595","tsp":1794607199964,"unit":"oz_t"}}}';
    expect(ticksFromFastForexQuotes(noAsk, symbols, precision, NOW)).toEqual([]);
  });

  it('skips a quote for another size or unit rather than rescaling it', () => {
    expect(
      ticksFromFastForexQuotes(FX.replace('"size":1}', '"size":100000}'), symbols, precision, NOW),
    ).toHaveLength(1);
    expect(
      ticksFromFastForexQuotes(METALS.replace('"oz_t"', '"gram"'), symbols, precision, NOW),
    ).toEqual([]);
  });

  it('yields nothing new when a poll returns the same quote again', () => {
    const seen = new Map<string, number>();
    expect(ticksFromFastForexQuotes(FX, symbols, precision, NOW, seen)).toHaveLength(2);
    expect(ticksFromFastForexQuotes(FX, symbols, precision, NOW, seen)).toHaveLength(0);
  });

  it('knows a metal from a currency pair', () => {
    expect(isFastForexMetal('XAUUSD')).toBe(true);
    expect(isFastForexMetal('XAGEUR')).toBe(true);
    expect(isFastForexMetal('EURUSD')).toBe(false);
  });
});
