# Trading engine

The engine is the part of the system that turns an intent into a financial fact.
Phase 1 delivers its domain foundations — state machines, protective-order logic,
formulas, risk rules — all pure and fully tested. Phase 4 wires them to
persistence and the market feed.

## Order submission path

```
 request
   │
   ├─ 1. Idempotency claim        unique (scope, key) — a retry never reaches step 3
   ├─ 2. Validate                 symbol known, volume on the lot grid, SL/TP on the right side
   ├─ 3. Quote                    latest tick; STALE_QUOTE if older than maxAgeMs
   ├─ 4. Price                    BUY → ask, SELL → bid
   ├─ 5. Margin                   requiredMargin at the executable price
   ├─ 6. Risk                     every rule evaluated; all violations returned at once
   ├─ 7. TRANSACTION
   │      order → order_events → execution → position → ledger → account
   ├─ 8. Store idempotent response
   └─ 9. Publish                  order.filled, position.created, account.updated
```

Steps 1–6 can reject. Step 7 is atomic. Step 9 is best-effort: a dropped
WebSocket frame costs a client a re-snapshot, never a financial inconsistency.

## Tick handling path

For each tick, per affected position:

```
 mark to market  → exitPriceFor(side, quote)
 floating P&L    → grossPnl(...)
 trailing stop   → nextHighWater() then nextTrailingStop()
 protective      → evaluateProtectiveTrigger() → STOP_LOSS | TAKE_PROFIT | null
 account state   → equity, freeMargin, marginLevel
 stop-out        → isStopOut(state, stopOutLevelPercent)
 publish         → pnl.updated, account.updated
```

A triggered stop takes the same close path as a manual close, including the
`OPEN → CLOSING` guard, so the two cannot both close the same position.

## What must never happen

Taken from the specification's own list, with how each is prevented:

| Must never                                  | Prevented by                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| A retry creating two trades                 | `idempotency_keys` unique constraint, before any engine work           |
| A position closing twice                    | `OPEN → CLOSING` transition guard plus row version                     |
| Financial state living only in the frontend | Every value on screen originates from a persisted server value         |
| Floating-point money                        | `Decimal` in memory, `NUMERIC` in the database, CI guard on the schema |
| Polling standing in for realtime            | ESLint bans `setInterval`; WebSocket carries state                     |
| A silently swallowed execution error        | Errors are typed `DomainError`s; the filter logs and codes every one   |
| An API timeout read as a rule breach        | Provider failures produce `SERVICE_UNAVAILABLE`, never a close         |

## Reliability

A market-data failure degrades trading; it never fabricates outcomes. When no
fresh quote is available:

- New orders are refused with `NO_QUOTE_AVAILABLE` or `STALE_QUOTE`.
- Open positions keep their last mark and are flagged stale in the UI.
- Protective orders do **not** fire — a missing price is not a price movement.
- On recovery, the feed is resynchronised and positions re-marked.

## Restart safety

State lives in PostgreSQL, not in process memory. On restart the API reloads open
orders and positions, re-subscribes to the market feed, and resumes. Executions
already written are not replayed: the idempotency table and the append-only event
log make the recovery path observable rather than a matter of trust.
