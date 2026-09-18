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
stayed on the tick path, because they _are_ the tick: "did the market trade
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

The failure mode that remains is the right one: under load the _frames_ thin out
while the _prices_ stay current, rather than the other way round.

### The simulator's timestamps drifted

`InternalMarketSimulator.pump` advanced each instrument's schedule by exactly one
interval per tick emitted, from wherever it started. A loop that runs a little
late every pass — and every timer does — left the timestamps on their original
grid while the wall clock moved on, and the lateness never came back.

The newest tick of a pass now carries the clock's current time, because that is
when it was observed, and the schedule re-anchors to `now + interval`. Catch-up
is bounded at eight ticks: a process paused for a minute would otherwise emit
hundreds of back-dated ticks in one pass.

## At five hundred traders (§74), and what that found

The same harness at `LOAD_TRADERS=500 LOAD_SOCKETS_PER_TRADER=2` — a thousand
sockets, two thousand simultaneous orders — found four things, in the order it
hit them. Each was fixed and pinned before the next run.

### Boot opened a pool per tenant

Role reconciliation entered every tenant's scope in turn at boot. A connection
is bound to one tenant for its life, so that is a pool per tenant, and
`DATABASE_TENANT_POOLS` did not bound it: an evicted pool keeps its connections
through a drain period. Against a development database the penetration suite had
filled with thirty-five tenants, two instances asked a stock Postgres for ~340
connections out of 100. Reconciliation failed for some tenants, the price-alert
sweep failed, and the first trader to register was told `INTERNAL_ERROR`.

Reconciliation is platform work and now runs through the one privileged pool
(`withoutTenantScope`); boot opens no tenant pool at all. The API also reports
its connection budget at boot — pools × `connection_limit` against the server's
`max_connections` — and says how many such instances fit side by side.
Pinned by `roles-reconciliation.test.ts` (six tenants, a cap of two, zero pools
opened) and `connection-budget.test.ts`.

### A frame per tick per socket

`onTick` sent every tick to every subscribed socket: **104 frames a second on
each of two hundred sockets**, ~20,000 serialisations a second for eight
instruments. At a thousand sockets the serving instance's event loop stalled
long enough that a single order on its own took six seconds and the process
lost its leadership lease.

Quotes are now conflated: the newest per symbol is kept and each socket is
sent one `quotes.updated` frame per `QUOTE_FANOUT_INTERVAL_MS` (100 ms) with
everything that moved. **19 frames a second per socket at a thousand sockets**,
all channels included. Nothing about trading changed — the engine prices from
its own freshness-checked quote, never from anything a client was shown. See
[websocket.md](./websocket.md#quotes-are-conflated).

### Keep-alive at Node's default

The steady phase paces orders five seconds apart, which is also Node's default
`keepAliveTimeout`. A client reusing a connection at the instant the server
closes it is reset; undici reports "other side closed" and does not retry a
POST. `HTTP_KEEP_ALIVE_TIMEOUT_MS` now defaults to 65 s, matching the edge, and
a smoke check holds a raw connection across a six-second pause.

### The burst overflowed the listen backlog

Two thousand orders at once arrive as ~1,500 new connections in one instant.
With the event loop busy serving what it already held, the accept queue —
Node's default backlog of 511 — filled. The kernel then drops the handshake's
final ACK: the client believes it is connected, sends its order, and some ten
seconds later gets `ECONNRESET`. **A hundred and twenty orders refused with no
code**, after which the client cannot know whether they exist. That is the one
outcome the platform must never produce, and the harness now records it as
`TRANSPORT:<cause>` so it fails the safe-refusal check by name.

Two changes, and both were needed. `HTTP_LISTEN_BACKLOG` (default 4,096,
clamped by the kernel to `somaxconn`) lets connections wait to be accepted
rather than be dropped. `HTTP_MAX_IN_FLIGHT` (default 512) is admission
control: above it the `DrainState` middleware refuses newcomers at once with a
coded 503 and `Retry-After: 1`, so the process never accepts more than it can
serve, stays responsive enough to keep saying no, and every refused order is
one the client knows was not placed. Liveness is always admitted. The run at
five hundred traders then passed with every refusal a safe one:
`SERVICE_UNAVAILABLE`, `STALE_QUOTE`, nothing else.

### Measured at five hundred traders, two-CPU container, ~10,000 open positions

|                                        |                                                   |
| -------------------------------------- | ------------------------------------------------- |
| Sockets                                | 1,000, zero sequence gaps, 19.4 frames/s each     |
| Steady phase, 500 concurrent per round | 35 orders/s, p50 13.3 s; 671/1500 `STALE_QUOTE`   |
| Burst, 2,000 simultaneous              | 512 admitted, 1,488 refused `SERVICE_UNAVAILABLE` |
| Sustained throughput                   | ~41 orders/s                                      |
| Newest tick age after the burst        | 53 ms                                             |
| Service time, unloaded, before / after | 368 ms / 431 ms                                   |

Read with the caveat the numbers deserve: the load generator — a thousand
sockets and two thousand fetches — runs on the same two cores as both API
instances, Postgres and Redis, and the platform was holding ten thousand open
positions accumulated by earlier runs (~750 when the table above this one was
measured; per-tick cost scales with open interest). The two-core figure is a
floor for the platform and a ceiling for this box.

## At a thousand traders and five thousand sockets

`LOAD_TRADERS=1000 LOAD_SOCKETS_PER_TRADER=5` on the same two cores is past
what the box can host, and the run said so in three ways worth keeping.

**The generator was the first thing to break.** It retained every frame from
five thousand sockets for gap-checking and reached four gigabytes; it now keeps
a count and a gap flag per socket. It also reported "92 frames a second per
socket" by dividing a twenty-minute run's frames by the twenty-second
observation window; the rate is now measured over the time the sockets were
open. Both were the harness measuring itself.

**A frame per position.** `pnl.updated` was one frame per open position per
valuation — thirteen per socket per half-second at this book. The figures come
from one valuation at one price and now travel in one frame per account, which
is also the honest shape: a screen never shows two positions at two moments.

**Valuing screens starved orders.** A realtime pass values every connected
account that is due, and at a thousand connected accounts it ran back to back
with itself; the loop was pricing screens nobody was waiting on while orders
people _were_ waiting on queued for minutes — 5 orders a second, p50 79 s, and
the admitted requests timed out at the client after five minutes with no
answer. Two controls now bound that. `REALTIME_VALUATION_BUDGET_MS` (250 ms)
caps how much of the loop one pass may take: it values as many due accounts as
fit, oldest first, and leaves the rest for the next pass, counted in
`tp_realtime_valuations_deferred_total`. Screens refresh less often under load;
the prices on them stay current; orders keep their share. And
`HTTP_MAX_EVENT_LOOP_LAG_MS` (1 000 ms) sheds newcomers on the loop's own
measure of being too busy, whatever the in-flight count — because a count
bounds how much is admitted and says nothing about how long each admitted
request then waits.

What it does not change: two cores cannot serve a thousand connected traders,
their generator, two API instances, Postgres and Redis. The scenario needs a
generator on another host and serving instances added behind the edge, which
is the §77 shape — WebSocket serving in its own containers, each valuing only
the accounts connected to it. Reported as a limit, not a defect.

## Measured on a two-CPU container, platform holding ~750 open positions

|                             |                                           |
| --------------------------- | ----------------------------------------- |
| One order, unloaded         | ~30ms                                     |
| Sustained throughput        | ~134–185 orders/s                         |
| Steady phase, 20 orders/s   | p50 ~1.1s, p95 ~1.6s                      |
| Burst, 1000 simultaneous    | drains in ~7.5s                           |
| Newest tick age, under load | ~200–300ms                                |
| Frames, 200 sockets         | ~104,000 over the run, zero sequence gaps |

## Run again on 18 September 2026, with 22,918 open positions

Re-run after a week of changes to the request path — HTTP metrics middleware
ahead of the drain, a rewritten day boundary, a report window resolver — to see
whether any of it cost anything. It did not, and the figures moved only with
open interest:

|                                 | 21,292 positions | 22,918 positions |
| ------------------------------- | ---------------- | ---------------- |
| One order, unloaded             | 54 ms            | **52 ms**        |
| Burst throughput                | 95 /s            | **76.7 /s**      |
| Steady phase                    | p50 4.7 s        | **p50 2.3 s**    |
| Newest tick age after the burst | 171 ms           | **495 ms**       |
| Frames, 200 sockets             | 55,630           | 53,430           |

**The one number worth reading is `Burst rejections: 506`.** Those are
admission control shedding, `SERVICE_UNAVAILABLE` and `STALE_QUOTE` — the
platform declining rather than filling at a price it did not trust. Until this
week they were invisible: `tp_http_requests_total` was declared and never
incremented, so the shipped `RequestsShed` alert queried a series that has never
existed. It is fed now, which means a burst like this one would page somebody
for the first time.

Unloaded service time did not move, which is the thing the new middleware could
have cost and did not: it records on `finish`, off the request's critical path.

## Run again on 17 September 2026, with 21,292 open positions

The same harness, same two-CPU container, on a platform that had accumulated
**21,292 open positions** — roughly twenty-eight times the ~750 the figures
above were taken against. Per-tick cost scales with platform-wide open interest,
so this is the interesting comparison:

|                                 | ~750 positions   | 21,292 positions |
| ------------------------------- | ---------------- | ---------------- |
| One order, unloaded             | ~30 ms           | **54 ms**        |
| Burst throughput                | ~134–185 /s      | **95 /s**        |
| Steady phase                    | p50 ~1.1 s       | **p50 4.7 s**    |
| Burst, 1000 simultaneous        | drains in ~7.5 s | **~10.5 s**      |
| Newest tick age after the burst | ~200–300 ms      | **171 ms**       |
| Frames, 200 sockets             | ~104,000         | 55,630           |

Every correctness assertion held: gapless sequences, no socket errored, every
socket received frames, the feed kept up, the platform came back, and **every
refusal was a safe one** — `SERVICE_UNAVAILABLE` and `STALE_QUOTE`, the engine
declining rather than filling at a price it did not trust, exactly as §26 asks.

The reading is the one this document already predicted: **the feed kept up while
per-order service time roughly doubled**. Open interest costs throughput, not
correctness, and `tp_open_positions` remains the gauge to watch.

## What the run asserts, and what it deliberately does not

It asserts: sequence numbers stayed gapless, every socket received frames, no
socket errored, the feed kept up, the platform came back, and **every refusal was
a safe one**.

That last one is the assertion that matters, and it is deliberately _not_
"nothing was rejected". `STALE_QUOTE` and `NO_QUOTE_AVAILABLE` are the engine
declining to fill at a price it does not trust — the answer §26 demands, and
under a deep enough queue the correct one. A platform that fills every order
under any load is filling some of them at prices it should not trust.

Anything else — an internal error, a conflicted idempotency key, a margin
decision that should not have been made — would mean the load had found a bug
rather than a limit, and fails the run.

Latency is otherwise printed, not asserted. A threshold that passes on one
machine and fails on a busy CI runner teaches nobody anything. The one exception
is the recovery check, which compares the platform against _itself_ before and
after the burst, on the same machine in the same run.

## What this means for deployment

- Run ingestion in its own process. `MARKET_INGEST_ENABLED=true` on exactly one;
  `false` everywhere else, where the relay feeds them.
- The trigger engine belongs with ingestion, not with the serving replicas.
- Per-tick cost scales with **platform-wide open interest**, not with how busy
  any one trader is. `tp_open_positions` is the gauge to watch.
- `tp_market_feed_age_ms` rising is the leading indicator of `STALE_QUOTE`
  refusals. Alert on it before traders notice.
- Size `HTTP_MAX_IN_FLIGHT` to a few seconds of one instance's throughput and
  add instances behind the edge rather than raising it: a refusal with a code
  is recoverable, a queue the loop cannot drain is not. The boot log's
  connection-budget line says how many instances the database will take.
- Give the client a retry on `503` + `Retry-After` for reads and for
  idempotent writes (every order carries an `Idempotency-Key`, so a retry can
  never double-fill).
- The hosts must differ: run the load generator somewhere other than the
  platform, or the numbers measure the contest for the cores.
