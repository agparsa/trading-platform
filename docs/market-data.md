# Market data

## The port

`MarketDataProvider` (`packages/market-core/src/provider.ts`) is the only market
interface the trading engine knows:

```ts
listInstruments(): Promise<readonly InstrumentDefinition[]>
getLatestTick(symbol): Promise<Tick | null>
getCandles(symbol, resolution, from, to): Promise<readonly Candle[]>
subscribe(symbol, listener): Unsubscribe
start(): Promise<void>
stop(): Promise<void>
```

Implementations:

| Implementation               | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `InternalMarketSimulator`    | Development and load testing. Seeded, deterministic. |
| `ScriptedMarketDataProvider` | Tests. Plays an exact hand-written tick list.        |
| _(future)_ external adapter  | A real broker or LP feed.                            |

Swapping one for another must not require a single change inside the engine.
That is the whole point of the port.

## Determinism

The simulator owns **no timers**. `pump()` is called by whatever drives time — a
scheduler in the API process, a loop in a test — after the clock has advanced.
Combined with a seeded PRNG (`SeededRandom`, mulberry32), the same seed replays
the same market on every machine, forever.

A market that cannot be replayed cannot be used to reproduce a trading bug.

`MARKET_SIMULATOR_SEED` fixes the seed; `MARKET_SIMULATOR_TICK_MS` sets the
interval. The price path is a multiplicative random walk, so prices stay positive
and volatility scales with price. The spread widens with the size of each move,
the way it does around news.

## Quote freshness

```ts
isTickFresh(tick, now, { maxAgeMs: 5000 });
```

A price from 30 seconds ago is not a price. Executing against one is how a
platform gives money away during a feed outage, so staleness is a first-class
concept and `STALE_QUOTE` is a distinct error code. A tick timestamped in the
future is also rejected — that means clock skew, and it is equally unusable.

## Candles

`CandleAggregator` builds OHLCV from the **bid**, matching how price charts are
drawn on broker terminals: the chart shows what a long would be marked at, not
the mid. Mixing bid candles with mid-priced P&L is a reliable source of "the
chart says I was in profit" support tickets.

Buckets are aligned to the epoch grid, not to the first tick received, so two
processes aggregating the same stream produce identical candles. Out-of-order
ticks are reported rather than silently folded into the wrong bucket.

Resolutions: `1`, `5`, `15`, `30`, `60`, `240`, `1D` — the string form the
charting datafeed expects.

## Sessions

`MarketSession` rows store weekly windows in an explicit IANA timezone, per
symbol. The timezone is stored on the row rather than inherited from the server,
so changing the server's timezone cannot silently move every session. Metals and
FX run Sunday 22:00 → Friday 21:00 UTC; crypto never closes.
