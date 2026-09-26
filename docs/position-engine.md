# Position engine

## States

```
 ┌──────┐   close requested   ┌─────────┐   fill   ┌────────┐
 │ OPEN │ ──────────────────► │ CLOSING │ ───────► │ CLOSED │  ← terminal
 └──────┘                     └────┬────┘          └────────┘
     ▲                             │
     └───── close failed ──────────┘
```

`CLOSING` is a real state, not a UI flourish. It is what stops a manual close, a
stop-loss trigger and a liquidation from all closing the same position three
times. Whoever transitions `OPEN → CLOSING` first owns the close; everyone else
gets `POSITION_ALREADY_CLOSING`.

`CLOSING → OPEN` exists because a close attempt can legitimately fail — no quote
available, provider timeout — and the position must survive rather than being
stranded.

The close that fails puts it back itself. A close that **dies** — the process
killed between the claim and the transaction that settles it — put nothing
back, and the position stayed `CLOSING`: no stop-loss, take-profit or stop-out
reads that status, and every close is refused as already in progress. The
trigger engine's leader now looks once a minute for positions `CLOSING` for
more than two minutes (`ABANDONED_CLOSE_AFTER_MS`) and reopens them, with a
`CLOSE_ABANDONED` row in the position's trail. Nothing was booked: the
transaction that writes the trade and the ledger is the one that moves the
status off `CLOSING`.

Both the settlement and a close's own release are conditional on **that
close's** claim — the status and the version its claim produced. A close still
running when the sweep reopens its position, and perhaps after another close
has taken and settled it, writes nothing and tells its caller
`CONCURRENT_MODIFICATION`: one close, one trade, one set of postings.
`trading.test.ts`, "failure recovery", drives all three.

## Concurrency

Every position row carries a `version` column. Updates are conditional on the
version the reader saw:

```sql
UPDATE positions SET ..., version = version + 1
WHERE id = $1 AND version = $2
```

Zero rows affected means someone else moved first; the caller gets
`CONCURRENT_MODIFICATION` and retries against fresh state. The specification's
concurrency scenarios (§22) all reduce to this plus the `CLOSING` guard:

| Scenario                    | Resolution                                                          |
| --------------------------- | ------------------------------------------------------------------- |
| Two close requests          | First wins `OPEN → CLOSING`; second gets `POSITION_ALREADY_CLOSING` |
| Close + SL trigger together | Same guard; the loser is a no-op, not a second trade                |
| Modify + close              | Version check rejects the stale writer                              |
| Duplicate order submission  | Idempotency key, before any engine work                             |
| Price update during close   | The execution records the exact quote it used                       |

## Protective orders

`packages/trading-core/src/protective-orders.ts`.

**Validation.** A long's stop-loss must sit below the reference price and its
take-profit above; a short is mirrored. A stop-loss placed on the profitable side
is not a harmless typo — it fires on the next tick and closes the position the
trader just opened. Levels must also sit on the instrument's tick grid.

**Triggering.** Evaluated on the _executable exit_ price — bid for a long, ask
for a short — because that is the price the position would actually close at.
Using the mid, or the entry side, fires stops late for longs and early for shorts.

**Ambiguous ticks.** When one tick spans both the stop-loss and the take-profit,
the intra-tick path is unknowable. The stop-loss is checked first, always. The
platform resolves the ambiguity the same way every time rather than silently
picking whichever branch is better for the house or the trader.

**Trailing stops.** `nextHighWater()` tracks the best exit price seen;
`nextTrailingStop()` returns a new level only when it improves on the current
one. A trailing stop never moves against the trader.

## Partial close

A partial close reduces `volume` while leaving `initialVolume` untouched, writes
a `Trade` row for the closed portion, and posts the realized amount to the
ledger. Keeping `initialVolume` is what makes the close history reconstructable
after several partials.
