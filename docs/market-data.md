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

## What a day is here — three answers, on purpose and not interchangeable

| Surface                                                                    | A day is                                       | Where                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------- |
| today's P&L, a `DAY` order's expiry, the swap accrual key, a report window | midnight in `TRADING_SERVER_TIMEZONE`          | `startOfTradingDay` / `endOfTradingDay` |
| a session window                                                           | the **instrument's own** IANA zone, per symbol | `MarketSession.timezone`                |
| a `1D` candle                                                              | **midnight UTC, always**                       | `bucketStart`, on the epoch grid        |

The third is the one a reader would not guess, and it is worth saying out loud
because nothing else in this platform works that way. `bucketStart` aligns to
the epoch grid — its own comment says so, so the code is honest — but the
consequence was unstated: **the daily bar ignores the trading server's timezone
entirely.** On a broker at UTC+2, the ordinary FX arrangement, the daily candle
opens at 02:00 local while everything else the trader sees rolls over at
midnight local. `H4` sits on the same grid, so the last four-hour bar of a local
day straddles that day's boundary.

`TRADING_SERVER_TIMEZONE` is `UTC` in both shipped examples, so today all three
agree. They stop agreeing the moment the broker timezone is set.

**Whether to change it is a decision, not a defect to fix quietly.** Stored
`candles` rows are keyed by `(symbol, resolution, bucket start)`, so moving the
daily boundary is a migration and a backfill of every historical bar, and it
changes what every chart has shown until now.
`packages/market-core/src/day-boundary.test.ts` pins the current behaviour so a
change has to be deliberate; it deliberately does **not** assert that the UTC
grid is right.

`MarketSession` rows store weekly windows in an explicit IANA timezone, per
symbol. The timezone is stored on the row rather than inherited from the server,
so changing the server's timezone cannot silently move every session. Metals and
FX run Sunday 22:00 → Friday 21:00 UTC; crypto never closes.

## The integrity gate

Every tick passes `TickGate` (`@tp/market-core`) before it becomes a price.
`MarketFeedService.ingest` is the only door, and it is the only door for the
built-in simulator, for the relay on a non-ingesting instance, and for any
external provider adapter that pushes.

Seven ways a tick is refused, in two groups.

**Impossible data — never accepted, however often it repeats.**

| Reason         | What it means                                        |
| -------------- | ---------------------------------------------------- |
| `MALFORMED`    | bid, ask or timestamp is not a number                |
| `NON_POSITIVE` | a price at or below zero                             |
| `CROSSED`      | ask not above bid                                    |
| `OUT_OF_ORDER` | older than the tick already accepted for that symbol |
| `FUTURE`       | timestamped beyond `MARKET_MAX_FUTURE_SKEW_MS` ahead |

**Implausible markets — refused, then followed.**

| Reason   | Threshold                                                     |
| -------- | ------------------------------------------------------------- |
| `SPREAD` | spread over `MARKET_MAX_SPREAD_RATIO` of the mid              |
| `SPIKE`  | mid moved over `MARKET_MAX_JUMP_RATIO` between accepted ticks |

After `MARKET_REANCHOR_AFTER` consecutive rejections of the second kind, the
gate accepts the next tick and re-anchors on it, logging loudly and counting it
in `tp_market_ticks_reanchored_total`.

That re-anchoring is the part worth arguing about, so here is the argument: a
guard that never re-opens freezes the price. The engine then marks positions,
computes margin and evaluates stops against an anchor that stopped moving —
silently, and with every appearance of working. A market really can gap 10% and
really can open with a spread five times normal. When it does, following it is
the safe direction; refusing forever is not.

The first group never re-anchors, because a crossed book is not a market
condition and accepting one after five repetitions would only corrupt prices
more slowly.

### What a rejection is not

It is a statement about the **feed**. Nothing in this path closes a position,
breaches an account or fails an order — §26's rule that an API fault must not be
read as a rule violation applies to the price stream too. The worst a rejection
does is leave the previous price standing, and `QuoteService.requireFresh` is
what decides whether that price is still fit to trade on.

### Ordering, twice

`QuoteService.publish` also refuses a tick older than the one it holds, and
returns `false` when it does. That is deliberate duplication: "the newest tick
wins" is a property of the quote, not of any one caller, and `publish` is
reachable from the ingest loop, the relay, and tests.

### Conversion rates must be fresh

`ConversionService` reads through `requireFresh`, not `latest`. A conversion
rate is not a display figure — it multiplies P&L, margin and exposure on every
position quoted in a foreign currency. An hour-old rate does not make those
numbers slightly stale; it makes them wrong by however far the currency has
moved, and nothing on screen or in the ledger would say so. A stale rate
therefore behaves exactly like a missing one, and the caller refuses.

USDJPY exists in the seed for this reason. It is the first instrument not quoted
in USD, which makes the conversion path the ordinary case rather than the
untested one. `apps/api/test/integration/conversion.test.ts` holds the figures.

### Relaying to non-ingesting instances

Exactly one process may pull from the provider, or candle volume is counted
twice. Every other instance still runs valuations, serves `GET /market/quotes`
and pushes account frames to its own sockets — so it subscribes to `market:ticks`
and feeds what arrives through the same gate. It does not re-publish (that would
echo forever) and does not persist candles (the ingesting instance owns those
rows).

`market:ticks` was being published to and nothing was listening. That was
survivable only while nothing had been scaled past one instance.

### Health

`GET /health/market` reports the age of the newest tick, how many instruments
are priced, how many ticks have been rejected, and — by name — which instruments
are currently in a rejection run.

It is deliberately **not** part of `/ready`. A process pulled out of the load
balancer because the upstream feed stopped is a process that cannot serve
history, account state or the ledger either, and traders would lose the screen
that tells them what has happened. Alert on it; do not route on it.
