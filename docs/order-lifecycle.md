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
