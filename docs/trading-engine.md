# Trading engine

The engine is the part of the system that turns an intent into a financial fact.
Phase 1 delivered its domain foundations — state machines, protective-order
logic, formulas, risk rules — all pure and fully tested. Phase 4 wired them to
persistence and the market feed. Phase 6 added the trigger engine, which is what
lets the platform act on a price move without a trader present.

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

## The trigger engine

`TriggerEngineService` subscribes to the in-process `TickBus` and does three
things per tick, **in this order**:

1. **Trailing stops ratchet.** A level that has improved is persisted before
   anything is evaluated against it.
2. **Protective levels fire.** `evaluateProtectiveTrigger` on the executable
   exit price — bid for a long, ask for a short.
3. **Stop-outs are checked** for accounts holding that symbol.

The ordering is narrower in effect than it looks, and worth stating precisely
rather than hand-waving: when the ratchet _moves_ a stop, it moves it to
`highWater − distance`, and the high-water mark only advances on a tick that is
itself the new best price — so a stop the ratchet just moved can never fire on
the same tick. Where the order does change the outcome is when a stop was
lowered out of band (a trader overriding a trailed level) and the ratchet
restores it into the money: evaluating first would delay that close by one tick
and fill it a tick worse. That is the whole of it.

### Design decisions worth knowing

**Ticks are processed one at a time per symbol.** A tick arriving while a pass is
in flight is _dropped_, not queued: the next tick carries a newer price, and
acting on a superseded one fires stops against a market that has already moved.

**The bus awaits its handlers.** Ticks are ordered events; running them
concurrently would let two passes evaluate the same position against different
prices and both decide to close it. The `OPEN → CLOSING` guard would catch that,
but relying on a race guard for ordinary operation is not a design.

**Trailing updates are version-guarded.** If the trader moves the stop between
the engine's read and its write, the trader's value wins and the ratchet retries
on the next tick.

**Liquidation is incremental.** Positions close largest-margin-first, one at a
time, re-valuing after each. Closing one frees margin and the account frequently
recovers before the rest need to go; dumping the whole book at once would cost
the trader positions that did not have to be closed. The loop is bounded at 20
passes so a pathological account cannot occupy the tick loop.

**Losing the close race is not an error.** When a trader closes manually a moment
before a stop fires, the engine gets `POSITION_ALREADY_CLOSING` and moves on
silently. Logging that at error level would train operators to ignore the log.

**`currentPrice` is not written on every tick.** That would be one write per
position per tick. It is persisted when a position closes; live valuation reads
the quote cache instead.

### The one knob that is not a performance knob

`TRIGGER_ENGINE_ENABLED=false` means stop-loss and take-profit **never fire** on
that instance. It exists so extra API replicas do not each run the engine, and
the service logs a warning at startup when it is off.

Running two engines would not corrupt anything — the `OPEN → CLOSING` guard
serialises them — but it would double the database load for no benefit.

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
