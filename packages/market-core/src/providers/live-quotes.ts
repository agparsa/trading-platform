import { Decimal, toDecimal } from '@tp/financial-core';
import type { Tick } from '../types';

/**
 * Real prices from outside, turned into the platform's `Tick`.
 *
 * Pure functions: a venue's message in, a tick or nothing out. The sockets,
 * the reconnecting and the clock live in the API (`LiveFeedService`); what is
 * here can be tested against the exact payloads the venues document, and is.
 *
 * A message that is not a quote, names an instrument the platform was not
 * told to follow, or carries a price that is not a positive number, is
 * nothing — never a guess. `MarketIntegrityService` then judges the tick as it
 * judges every other.
 */

/** Which platform instrument a venue's symbol is, e.g. `btcusdt` → `BTCUSD`. */
export type SymbolMap = Readonly<Record<string, string>>;

/**
 * `BTCUSD:btcusdt,ETHUSD:ethusdt` → `{ btcusdt: 'BTCUSD', ethusdt: 'ETHUSD' }`.
 *
 * Written platform-code first, because that is what an operator reads down a
 * list for. The venue's symbol is kept exactly as written: Binance's are lower
 * case in stream names, Twelve Data's are `EUR/USD`.
 */
export function parseSymbolMap(text: string): SymbolMap {
  const map: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const [code, venue] = pair.split(':').map((part) => part.trim());
    if (code === undefined || venue === undefined || code === '' || venue === '') continue;
    map[venue] = code;
  }
  return map;
}

function positive(value: unknown): Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const number = toDecimal(text);
  return number.greaterThan(0) ? number : null;
}

function tick(
  symbol: string,
  bid: Decimal,
  ask: Decimal,
  precision: number,
  timestamp: number,
): Tick | null {
  // Rounded away from each other, so rounding can never cross the book.
  const b = bid.toDecimalPlaces(precision, Decimal.ROUND_DOWN);
  const a = ask.toDecimalPlaces(precision, Decimal.ROUND_UP);
  if (!b.greaterThan(0) || a.lessThan(b)) return null;
  return {
    symbol,
    bid: b.toFixed(precision),
    ask: a.toFixed(precision),
    timestamp,
    volume: '0',
  };
}

/**
 * Binance's best bid and ask, from the public `<symbol>@bookTicker` stream.
 *
 * Documented payload (combined streams wrap it in `{ stream, data }`):
 * `{"u":400900217,"s":"BNBUSDT","b":"25.35190000","B":"31.21","a":"25.36520000","A":"40.66"}`.
 * It carries no time, so the time is when it arrived. The pairs are quoted in
 * USDT, a dollar stablecoin: close to, and not the same thing as, the dollar —
 * `docs/market-data.md` says so where an operator will read it.
 */
export function tickFromBinanceBookTicker(
  raw: string,
  symbols: SymbolMap,
  precisionOf: (code: string) => number | undefined,
  now: number,
): Tick | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const body =
    typeof message === 'object' && message !== null && 'data' in message
      ? (message as { data: unknown }).data
      : message;
  if (typeof body !== 'object' || body === null) return null;
  const { s, b, a } = body as { s?: unknown; b?: unknown; a?: unknown };
  if (typeof s !== 'string') return null;
  const code = symbols[s.toLowerCase()];
  if (code === undefined) return null;
  const precision = precisionOf(code);
  const bid = positive(b);
  const ask = positive(a);
  if (precision === undefined || bid === null || ask === null) return null;
  return tick(code, bid, ask, precision, now);
}

/**
 * A Twelve Data price event, from `wss://ws.twelvedata.com/v1/quotes/price`.
 *
 * Documented fields: `event: "price"`, `symbol`, `timestamp` (UNIX seconds),
 * `price`, and — "where available" — `bid` and `ask`. With a bid and an ask
 * the tick is theirs. With only a price the platform quotes its own spread
 * around it (`halfSpreadOf`), which is what a dealing desk does with a mid and
 * is stated as such; with no configured spread there is no tick.
 *
 * PENDING VERIFICATION: written from the published documentation, not yet run
 * against a live key. See `docs/market-data.md`.
 */
export function tickFromTwelveDataPrice(
  raw: string,
  symbols: SymbolMap,
  precisionOf: (code: string) => number | undefined,
  halfSpreadOf: (code: string) => string | undefined,
  now: number,
): Tick | null {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof message !== 'object' || message === null) return null;
  const event = message as {
    event?: unknown;
    symbol?: unknown;
    price?: unknown;
    bid?: unknown;
    ask?: unknown;
    timestamp?: unknown;
  };
  if (event.event !== 'price' || typeof event.symbol !== 'string') return null;
  const code = symbols[event.symbol];
  if (code === undefined) return null;
  const precision = precisionOf(code);
  if (precision === undefined) return null;
  const at =
    typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? Math.min(now, Math.round(event.timestamp * 1000))
      : now;

  const bid = positive(event.bid);
  const ask = positive(event.ask);
  if (bid !== null && ask !== null) return tick(code, bid, ask, precision, at);

  const price = positive(event.price);
  const half = positive(halfSpreadOf(code));
  if (price === null || half === null) return null;
  return tick(code, price.minus(half), price.plus(half), precision, at);
}

/**
 * At most one tick per instrument per interval, and always the latest.
 *
 * A book ticker prints hundreds of times a second in a busy market. The
 * platform evaluates every stop against every tick it ingests and writes each
 * to Redis; four a second is a live price, four hundred is a denial of service
 * on itself. Nothing is averaged — a tick that is let through is one the venue
 * sent.
 */
export class TickThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly minIntervalMs: number) {}

  admit(tick: Tick): boolean {
    const previous = this.last.get(tick.symbol);
    if (previous !== undefined && tick.timestamp - previous < this.minIntervalMs) return false;
    this.last.set(tick.symbol, tick.timestamp);
    return true;
  }
}
