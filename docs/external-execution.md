# External execution

How an order reaches a venue, what happens when the answer does not come
back, and why nothing here ever guesses.

This is the Phase 3 layer. Phase 2 built the port (`@tp/broker-sdk`) and the
connections that hold credentials; this is what uses them.

---

## 1. Two kinds of account

`Account.executionMode` is either `INTERNAL` or `EXTERNAL_BROKER`.

An internal account executes on this platform's own engine against its own
quotes, and its money moves on this platform's ledger. That is every account
the platform has had until now, and nothing about it changed.

An external account's money is at a venue. This platform records what the
venue did; it does not price the fill, invent the commission, or move a
ledger entry the venue has not made. An external account therefore carries
two more fields — the connection it trades through and its identity at that
venue — and the database refuses the combination that would be meaningless:

```sql
CONSTRAINT accounts_execution_mode_consistent CHECK (
  execution_mode = 'INTERNAL'
  OR (broker_connection_id IS NOT NULL AND external_account_id IS NOT NULL)
)
```

An external account with no venue identity cannot exist, so the order path
never has to ask whether it might.

`@@unique([brokerConnectionId, externalAccountId])` says the other half: one
venue account belongs to one platform account. Two accounts pointed at the
same venue account would each see the other's fills as its own.

---

## 2. One branch, and where it is

`OrdersService.openPosition` gains exactly one branch, before pricing:

```ts
if (ExternalExecutionService.isExternal(account)) { … }
```

Everything before it is unchanged and still applies: the account must be
tradeable, the market must be open, the volume must be a legal size, the kill
switch must be off, the throttle must not be hit. An external account is not
a way around the platform's own refusals — it is a different place for a
legal order to go.

Everything after it — margin, the internal fill, the ledger movement — is what
external execution replaces.

---

## 3. The order row exists before the request leaves

```
order row (ACCEPTED, clientOrderId)   ← written first, committed
        ↓
request to the venue
        ↓
answer, or no answer
```

This ordering is the whole recovery story. If the platform sent first and
recorded afterwards, a crash in between would leave a position at a venue
that this platform has no record of and no id to ask about. Writing first
costs one row that may turn out to describe nothing; not writing first costs
a position nobody can find.

`clientOrderId` is minted here (`tp-<uuid>`), sent with the order, and stored
on the row. It is the only handle the platform has on an order it cannot see,
so it is unique — `@@unique([tenantId, clientOrderId])` — and it is never
reused. Per firm rather than platform-wide because the column also holds
references a _caller_ chose, and two firms both reaching for `order-1` must not
collide; the ids this file mints are UUIDs, which would not have collided
either way.

---

## 4. UNCONFIRMED

`OrderStatus.UNCONFIRMED` means: _this order was sent, and we do not know what
became of it._

It is not "failed" and not "pending". It is ignorance, written down. The
platform reaches it in exactly two ways:

- the adapter answered `UNKNOWN` — the request left, the reply did not come;
- the call threw at all — a dropped connection, a timeout, a venue error.

The second is deliberate and is the one rule the specification states twice:
**an API timeout is never read as an outcome.** A connection that failed is a
fact about the connection. Recording it as a rejection would tell a trader
their order did not go through while the venue holds a position for them.

The state machine allows `ACCEPTED → UNCONFIRMED`, and out of it only to a
definite end — `PARTIALLY_FILLED`, `FILLED`, `REJECTED`, `CANCELLED`,
`EXPIRED`. There is no path back to `ACCEPTED` and no self-loop: an order
leaves this state once, when a venue says something.

---

## 5. Recovery: ask, never resend

`VenueRecoveryService` sweeps every `UNCONFIRMED` order older than
`VENUE_RECOVERY_GRACE_MS` and asks its venue, with the id that was sent:

| The venue says        | The platform does                                          |
| --------------------- | ---------------------------------------------------------- |
| filled / partially    | books exactly that, at the venue's price                   |
| working               | leaves it working                                          |
| rejected              | records the rejection with the venue's reason              |
| **no record of it**   | cancels the order — `rejectionCode` `VENUE_NEVER_RECEIVED` |
| _(cannot be reached)_ | nothing; it stays UNCONFIRMED and is asked again           |

The last two rows are the ones that matter.

**No record of it** is the only state in which it is safe to say nothing
happened — and even then the order is _cancelled_, not re-placed. A resend is
how one intent becomes two positions. Whether to try again, at today's prices
rather than the ones that are now stale, is the trader's decision.

**Cannot be reached** produces no decision at all. No number of failed queries
adds up to evidence about an order. The sweep counts it unresolved, logs it,
and tries again.

The grace period exists because the original request may still be in flight:
a query that overtakes it reads a state that is about to change.

The sweep runs in the API rather than the worker for the same reason
snapshots do — applying a venue's answer to orders, executions, positions and
the outbox is `ExternalExecutionService`, and a second copy of that in another
process would be a second definition of what a fill is.

`/admin/venue-recovery` exposes the waiting list and an "ask again" button.
There is deliberately no route that _decides_ an order's fate by hand.

---

## 6. Instrument mappings

`XAUUSD` here may be `XAUUSD.m`, `GOLD` or `XAU/USD` there, with its own lot
step and price precision. A `BrokerInstrumentMapping` says which, per
connection, and it is always written by a person:

- **an unmapped instrument cannot be traded on that connection.** The refusal
  names what is missing rather than falling back to this platform's own
  symbol.
- `suggest()` offers candidates by normalised name and stops at the first
  ambiguity — a venue listing both `XAUUSD` (spot) and `XAUUSD.f` (futures)
  is exactly the case where "obvious" matching trades the wrong contract.
- the venue's own `contractSize`, `volumeStep`, `minVolume`, `maxVolume` and
  `priceDecimals` are copied at map and re-read by `sync()`, which **reports**
  what moved and repairs nothing. A mapping whose instrument the venue has
  stopped listing is reported and left: renamed, retired or a bad catalogue
  read are different things, and telling them apart is not a sweep's job.

---

## 7. The outbox

`OutboxEvent` is written **in the same transaction as the change it
describes**.

The window this closes is small and expensive: publishing inside the
transaction announces a fill a rollback is about to erase; publishing after it
loses the announcement if the process dies in between. A row written with the
change exists if and only if the change committed.

The socket is still served directly by `EventsService`, because a trader
watching a position should not wait for a relay. Both carry the **same
`eventId`**, minted in the outbox, so one occurrence has one id however many
ways it travels.

The worker's `OutboxRelayService` hands rows on. Today no destination is
registered — webhooks are Phase 12 — so it marks them RELAYED and the outbox
is a queryable record of every domain event the platform produced, which is
what "did that event ever go out" is answered from. When a destination exists,
a failure is kept: attempts counted, next attempt scheduled with a widening
backoff **held in the row** so a restart cannot lose it, and after
`OUTBOX_MAX_ATTEMPTS` the row is `ABANDONED` rather than deleted. A financial
event nobody could be told about is something a person must see.

A database trigger fixes the content of an outbox row; only the delivery
bookkeeping moves.

---

## 8. The inbox

`BrokerInboundEvent` records what a venue sent, **before** it is acted on.

Three things venues do that are not errors:

- **redeliver**, because an acknowledgement was lost —
  `(connectionId, externalEventId)` is unique, so the second insert is
  reported as a duplicate, not a second fill;
- **deliver late**, so `sequence` is kept as the venue gave it and readers
  order by the venue's clock rather than ours;
- **deliver out of order**, handled the same way: record first, reason
  afterwards, in the venue's order.

Recording is separate from applying. An event the platform cannot yet make
sense of is still evidence, so the row is written whatever happens next, its
payload is fixed by a trigger, it can never be deleted, and only the handling
status moves: `PENDING → APPLIED | SKIPPED | FAILED`, with `FAILED → PENDING`
for a replay by corrected code.

---

## 9. What this layer refuses to do

- Resend an order. Ever. Not on a timeout, not on a reconnect, not on a
  recovery pass.
- Read an unreachable venue as an outcome.
- Trade an instrument it has not been told the venue's name for.
- Book a fill the venue did not report, or a price the venue did not give.
- Move an external account's ledger on the platform's own arithmetic.
- Delete an inbound event, or an undeliverable outbox row.
- Repair a discrepancy silently. Everything above is reported.

---

## 10. Configuration

| Variable                     | Default     | What it does                                              |
| ---------------------------- | ----------- | --------------------------------------------------------- |
| `VENUE_RECOVERY_INTERVAL_MS` | 30000       | How often venues are asked. `0` disables the sweep.       |
| `VENUE_RECOVERY_GRACE_MS`    | 5000        | How long an order is left before it is asked about.       |
| `OUTBOX_RELAY_CRON`          | `* * * * *` | How often the relay runs.                                 |
| `OUTBOX_BATCH_SIZE`          | 200         | Rows claimed per pass.                                    |
| `OUTBOX_MAX_ATTEMPTS`        | 10          | After this many failures a row is ABANDONED, not dropped. |

Disabling the sweep is a choice, not a default: unconfirmed orders then wait
for a person, and the API says so at boot.

---

## 11. Still pending a venue

There is no connector to a real venue in this repository, and there will not
be one until a venue's API documentation and sandbox exist. Everything above
is exercised against `MockBrokerAdapter`, which implements the failure
catalogue for real — lost answers, filled-but-unanswered, disconnects,
redelivery, out-of-order delivery. See
[broker-integration.md](./broker-integration.md) for what adding a connector
involves.
