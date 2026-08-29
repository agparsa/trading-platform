# Capacity, and what the load harness found

`pnpm load` runs a hundred traders, two hundred sockets and thirteen hundred
orders in three phases against a freshly built API. It reports numbers and fails
only on correctness.

## How it is deployed for the run

Two processes, as production runs: one instance ingesting market data with the
trigger engine on and serving nobody, and one serving everything with
`MARKET_INGEST_ENABLED=false`, relaying prices over `market:ticks`.

This is not an optimisation for the benchmark. Exactly one process may pull from
the provider or candle volume is counted twice, and the first hundred-trader run
demonstrated what happens when the same process does both.

## The three phases

**Steady** trickles orders continuously. It is the shape of ordinary trading and
the number a trader lives with.

**Burst** fires everything at once. It measures how long a queue takes to drain,
which is a different quantity from how long an order takes to serve, and it is
reported as such.

**Recovery** takes the single-order measurement again afterwards and compares it
with the one from before. A platform that serves a burst and then stays degraded
— exhausted pool, lock never released, memory that never comes back — passes a
burst test and fails in production an hour later.

## What it found, and what was fixed

### The stop-out sweep was back-pressure on the feed

`TriggerEngineService.runPass` valued **every account holding the ticked
instrument** inline, inside the tick handler. `TickBus` awaits its handlers in
order — deliberately, so a stop is evaluated against every price the market
printed — so that valuation was back-pressure on the feed itself.

Measured on an idle instance holding 750 open positions: one tick took about six
seconds to process, and the newest price the platform held was **seven seconds
old**. `requireFresh` then refused orders against it with `STALE_QUOTE`. The
engine was right to refuse. The price was late because of the sweep that was
judging it.

The three price comparisons — trailing stops, protective levels, resting orders —
stayed on the tick path, because they *are* the tick: "did the market trade
through this level" is answered exactly from the coalesced range, and answering
it late means firing at a price the market has left. The stop-out sweep moved to
its own loop. It was already throttled per account by
`STOP_OUT_CHECK_INTERVAL_MS`, so no account was ever valued on every tick; what
changed is that it now values against a price that is current.

**Idle feed age on that same instance: 7000ms → 350ms.**

### Realtime valuation was the same mistake, one layer up

`RealtimeService.onTick` valued every exposed listening account inline, for the
same reason and with the same effect. It now records which instruments moved and
drains on its own cadence, valuing a few accounts at a time.

The failure mode that remains is the right one: under load the *frames* thin out
while the *prices* stay current, rather than the other way round.

### The simulator's timestamps drifted

`InternalMarketSimulator.pump` advanced each instrument's schedule by exactly one
interval per tick emitted, from wherever it started. A loop that runs a little
late every pass — and every timer does — left the timestamps on their original
grid while the wall clock moved on, and the lateness never came back.

The newest tick of a pass now carries the clock's current time, because that is
when it was observed, and the schedule re-anchors to `now + interval`. Catch-up
is bounded at eight ticks: a process paused for a minute would otherwise emit
hundreds of back-dated ticks in one pass.

## Measured on a two-CPU container, platform holding ~750 open positions

| | |
| --- | --- |
| One order, unloaded | ~30ms |
| Sustained throughput | ~134–185 orders/s |
| Steady phase, 20 orders/s | p50 ~1.1s, p95 ~1.6s |
| Burst, 1000 simultaneous | drains in ~7.5s |
| Newest tick age, under load | ~200–300ms |
| Frames, 200 sockets | ~104,000 over the run, zero sequence gaps |

## What the run asserts, and what it deliberately does not

It asserts: sequence numbers stayed gapless, every socket received frames, no
socket errored, the feed kept up, the platform came back, and **every refusal was
a safe one**.

That last one is the assertion that matters, and it is deliberately *not*
"nothing was rejected". `STALE_QUOTE` and `NO_QUOTE_AVAILABLE` are the engine
declining to fill at a price it does not trust — the answer §26 demands, and
under a deep enough queue the correct one. A platform that fills every order
under any load is filling some of them at prices it should not trust.

Anything else — an internal error, a conflicted idempotency key, a margin
decision that should not have been made — would mean the load had found a bug
rather than a limit, and fails the run.

Latency is otherwise printed, not asserted. A threshold that passes on one
machine and fails on a busy CI runner teaches nobody anything. The one exception
is the recovery check, which compares the platform against *itself* before and
after the burst, on the same machine in the same run.

## What this means for deployment

- Run ingestion in its own process. `MARKET_INGEST_ENABLED=true` on exactly one;
  `false` everywhere else, where the relay feeds them.
- The trigger engine belongs with ingestion, not with the serving replicas.
- Per-tick cost scales with **platform-wide open interest**, not with how busy
  any one trader is. `tp_open_positions` is the gauge to watch.
- `tp_market_feed_age_ms` rising is the leading indicator of `STALE_QUOTE`
  refusals. Alert on it before traders notice.
