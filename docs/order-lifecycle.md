# Order lifecycle

The state machine lives in `packages/trading-core/src/state/order-state-machine.ts`
as a lookup table. Nothing in the platform assigns `order.status` directly;
every change goes through `transitionOrder(from, to)`, which throws
`INVALID_STATE_TRANSITION` on an illegal move.

## States

```
              ┌─────┐
              │ NEW │
              └──┬──┘
      ┌──────────┼──────────┐
      v          v          v
 ┌─────────┐ ┌────────┐ ┌──────────┐
 │ PENDING │ │ACCEPTED│ │ REJECTED │  ← terminal
 └────┬────┘ └───┬────┘ └──────────┘
      │          │
      v          │
┌───────────┐    │
│ TRIGGERED │────┤
└───────────┘    │
                 v
     ┌───────────────────┐
     │ PARTIALLY_FILLED  │──┐
     └─────────┬─────────┘  │ (repeats)
               v            │
          ┌────────┐  <─────┘
          │ FILLED │  ← terminal
          └────────┘

 MODIFY_REQUESTED  → back to PENDING / ACCEPTED / PARTIALLY_FILLED, or REJECTED
 CANCEL_REQUESTED  → CANCELLED, or FILLED / PARTIALLY_FILLED if a fill wins the race
 EXPIRED           ← terminal
```

Terminal states — `FILLED`, `CANCELLED`, `REJECTED`, `EXPIRED` — have no outgoing
transitions at all. A cancelled order can never be revived.

## Two transitions that look wrong and are not

**`CANCEL_REQUESTED → FILLED`.** A cancel racing a fill is a real event, not an
error. The fill wins and the cancel is reported to the client as too-late.
Forbidding this transition would force the engine to either discard a legitimate
execution or lie about the order's state.

**`MODIFY_REQUESTED → PENDING | ACCEPTED | PARTIALLY_FILLED`.** A modify that
fails must put the order back exactly where it was. The engine records the prior
status alongside the request so it can restore it rather than guessing.

## Happy paths

Market order:

```
NEW → ACCEPTED → FILLED → (position created)
```

Pending order:

```
NEW → PENDING → TRIGGERED → FILLED → (position created)
```

## Event log

Every transition appends a row to `order_events` with `fromStatus`, `toStatus`,
a typed event kind, and a JSON payload holding the prices and volumes involved.
The table is append-only. Reconstructing exactly what happened to an order is a
single indexed query, not an archaeology exercise across mutated rows.

## Idempotency

Every mutating endpoint requires an `Idempotency-Key` header. The
`idempotency_keys` table has a unique constraint on `(scope, key)`; the second
request loses the insert race and is served the stored response rather than
executing again. Scope is namespaced per account so two users cannot collide.

The stored `requestHash` matters: a key reused with a **different** payload is a
client bug and is rejected with `IDEMPOTENCY_KEY_CONFLICT`, not silently answered
from cache.

### The claim commits with the money

A claim has four states, and the third exists because of a crash the failure
injection harness produced on demand:

| State         | Meaning                                                                             | A retry with the same key…                                                                                  |
| ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `IN_PROGRESS` | claimed; nothing has committed                                                      | is refused as in flight — or **takes the claim over** once it is older than `IDEMPOTENCY_TAKEOVER_AFTER_MS` |
| `COMMITTED`   | the operation's transaction committed, **and marked the claim in that transaction** | is refused with `IDEMPOTENCY_RESULT_UNAVAILABLE`: applied, read the account                                 |
| `COMPLETED`   | the result was recorded                                                             | is answered from the stored result                                                                          |
| _(deleted)_   | the operation failed before anything committed                                      | runs afresh                                                                                                 |

`PrismaService.$transaction` does the marking: whenever a request runs under a
claim, the interactive transaction is wrapped so that, after the body's work and
before the commit, the claim's row is set to `COMMITTED` — in the same
transaction. Either the fill and the mark are both durable or neither is. No
service has to know; every `this.prisma.$transaction` gets it.

Before this, the recording happened _after_ the transaction, and a process
killed in between left a fill with a claim that still said `IN_PROGRESS`. Every
retry with the same key was then refused as "still in flight" for the key's
whole lifetime — a day — and the only path a client had left was a fresh key,
which fills again. Under `pnpm chaos`, 39 of 40 orders landed in exactly that
state. Now a retry gets `IDEMPOTENCY_RESULT_UNAVAILABLE` and must not retry with
a new key; the effect is visible on the account.

The takeover is what stops the _other_ crash — before commit — from blocking
retries for a day. A claim still `IN_PROGRESS` after the window (five minutes by
default, bounded far above any live request) belongs to a process that died, and
the retry takes it over with a conditional update that exactly one contender
wins. `abandon()` deletes a claim only while it is `IN_PROGRESS`; one the
transaction marked is kept, because whatever failed afterwards did not
un-happen the fill.

## Resting orders — LIMIT and STOP

**Implemented in Phase 10.**

### Which way each one waits

Four cases, two independent inversions. Getting one backwards turns a limit
order into a market order at the worst possible moment, so the rule lives in one
place — `waitsForFall` in `@tp/trading-core` — and every combination is tested.

| Order      | Rests        | Fires when             |
| ---------- | ------------ | ---------------------- |
| BUY LIMIT  | below market | ask falls to the price |
| SELL LIMIT | above market | bid rises to the price |
| BUY STOP   | above market | ask rises to the price |
| SELL STOP  | below market | bid falls to the price |

Everything is measured against the **executable entry price** — the ask for a
buy, the bid for a sell — because that is the price the trader would actually
pay. Measuring a buy against the bid would fire it at a price nobody can deal at.

Comparisons are inclusive. An order resting exactly at the printed price has been
reached; requiring the market to trade _through_ it would leave orders unfilled
at a price the market actually showed.

### Placement is refused on the wrong side

An order that would trigger immediately is not a resting order — it is a market
order the trader did not ask for, and it fires on the next tick at a price they
never saw. It is rejected at the boundary with `INVALID_PRICE`, and the message
says which side the price should have been on and suggests a market order.

The browser runs the same check, from the same package, so the mistake is caught
in the same keystroke rather than a round trip later.

### No margin is held while an order rests

That is the conventional model and the honest one: an order that may never fill
should not tie up buying power for a week, and reserving margin at placement
would mean a second definition of used margin that the account valuation knows
nothing about.

The consequence is that **risk is evaluated when the order fires**, against the
account as it stands then. An order the account can no longer carry is moved to
`REJECTED` with the rule's own code, an event, and a notification to the trader.
It is never filled into a margin call and never silently dropped — a resting
order that vanished without explanation is worse than one that failed loudly.

### Fills happen at the market, and the slippage is recorded

A triggered order fills at the executable price _now_, not at its resting price.
For a limit that is at least as good as asked. For a stop it may be worse, and
that difference is real money.

Both prices and their difference go into the `FILLED` event, so a trader
disputing a fill can see exactly what happened rather than being told a number.

### Time in force

| Value | Behaviour                                                 |
| ----- | --------------------------------------------------------- |
| `GTC` | Rests until filled or cancelled                           |
| `DAY` | Expires at the next midnight in `TRADING_SERVER_TIMEZONE` |

`DAY` is resolved to a timestamp once, when the order is placed, so nothing
downstream has to decide what a day means and a server that changes timezone
cannot reinterpret an order already resting.

**That midnight is a wall-clock midnight, which is 23 or 25 hours away twice a
year.** `endOfTradingDay` used to add the remaining minutes as if a day were
always 1440 of them, so an order placed between midnight and a clock change
expired an hour late — able to fill after the trader was told it would be gone —
or an hour early, cancelled with nothing said. The comment above the function
described the correction; the code did not do it. It does now, and
`session.test.ts` sweeps every minute of six transition days in three zones,
one of which (`Australia/Lord_Howe`) shifts by thirty minutes rather than an
hour.
| `GTD` | Expires at a supplied timestamp                           |

`DAY` is resolved to a timestamp **once, at placement**, so nothing downstream
has to decide what a "day" means and a server that changes timezone cannot
reinterpret an order already resting. `endOfTradingDay` is built on
`zonedDayAndMinute` rather than date arithmetic, because on the day a zone shifts
midnight is 23 or 25 hours away, not 24.

Orders are expired **before** they are fired on each tick, so an order that
lapsed at midnight cannot open a position on the first tick after it.

### Racing

A resting order is _claimed_ before it is priced: one conditional update from
`PENDING` to `TRIGGERED`. Two ticks arriving close together would otherwise both
see a resting order and both open a position from it. A claim that changes no
rows means another pass won, and this one stops.

A cancel racing a fill loses rather than undoing a position that already exists.

Both are verified by removing the guard: without the status condition on the
claim, two concurrent passes open two positions from one order.

### Known limitation

Placing a resting order requires a **fresh quote**, so orders cannot currently be
queued while the market is closed. Without a price there is no way to tell a real
resting order from a mistyped one that would fire on the next tick, and accepting
both would turn a typo into a market order. Queuing for the open needs a
last-known-price rule that is deliberate rather than incidental; it is not
implemented rather than guessed at.
