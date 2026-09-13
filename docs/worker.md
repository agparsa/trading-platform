# Worker

`apps/worker` runs the work that does not belong in a request.

The dividing line is not "slow" — it is **whether a trader is waiting for the
answer**. Order execution, stop-loss triggering and ledger writes happen inline
in the API, inside a database transaction, because a fill that arrives when a
queue gets round to it is not a fill. What lands here is work that is periodic,
sweeping, or reconciling.

Every processor is a thin wrapper around a service method that can be called
directly. The schedule is glue; the behaviour is testable without Redis, without
BullMQ, and without waiting for a cron to fire. All 18 worker tests call the
services, not the queues.

## Jobs

| Queue               | Schedule (default) | What it does                                                      |
| ------------------- | ------------------ | ----------------------------------------------------------------- |
| `swap-accrual`      | `0 0 * * *`        | Charges or credits overnight financing on every open position     |
| `reconciliation`    | `15 * * * *`       | Replays every ledger and compares it to the cached balance        |
| `idempotency-sweep` | `30 * * * *`       | Deletes expired keys; releases claims abandoned by a dead process |
| `account-snapshot`  | —                  | **No processor yet.** Needs live valuation; see below             |
| `notifications`     | —                  | **No processor yet**                                              |

Cron expressions are evaluated in `TRADING_SERVER_TIMEZONE`, not the host's.
Schedules are registered with `upsertJobScheduler`, which is idempotent: a
restart re-registers the same schedule instead of accumulating duplicates the way
a plain repeatable `add` would.

The startup log names the queues that have no processor. A queue that silently
accepts jobs nothing will ever run is worse than one that says so.

## Swap accrual

```
amount = swapRatePerLot(side) × volume × nights
```

The rate is signed on the instrument — negative debits, positive credits — so a
short can legitimately _earn_ financing. `nights` is 1, except on the configured
triple-swap day (`SWAP_TRIPLE_DAY`, default Wednesday) when it is 3.

Weekend financing is not a detail worth skipping. A position held across
Wednesday is financed for three days because settlement rolls over the weekend;
charging one night understates a week-long position's cost by two nights **every
week**, and that compounds into a real number on a large book.

Each accrual carries a ledger idempotency key of `swap:{positionId}:{tradingDay}`.
Two things enforce single-charging, and they are not redundant:

- The **unique index** on `balance_ledger.(tenant_id, idempotency_key)` is the
  guarantee. It holds even if the application forgets to check. The firm is part
  of the key on purpose: a unique index is enforced across the rows row-level
  security hides, so a global one would let one firm's swap key refuse
  another's. See `docs/database.md`.
- The **in-transaction lookup** is what makes a retry a quiet no-op rather than a
  failed transaction and an alarming log line.

The ledger entry and the position's running `swap` total move in one transaction,
because a partial close releases swap in proportion to the volume closed — verified
live: a 0.40-lot close of a 1.00-lot position with −4.25 accrued released exactly
−1.70 and left −2.55 behind.

### The limitation, stated plainly

The worker has no market feed and therefore no FX rate. A position whose
instrument is quoted in a currency other than its account's is **skipped and
reported**, not accrued. Inventing a rate would put a wrong number directly into
the ledger, and a wrong number in a ledger is worse than a missing one.

Every instrument currently shipped is USD-quoted against USD accounts, so nothing
is skipped today. Supporting cross-currency accrual means giving the worker a rate
source — the API's quote cache in Redis is the obvious candidate.

## Reconciliation

`accounts.balance` is a cache. `balance_ledger` is the record. This job replays
every account's entries and compares.

A mismatch means something wrote a balance outside the ledger service, which is
the most serious alarm this system can raise: the number a trader is looking at is
not backed by an auditable trail.

**Discrepancies are recorded, not repaired.** A `LEDGER_DRIFT` risk event is
written at `CRITICAL` severity with both figures and the difference. Auto-correcting
would erase the evidence of how the drift happened, and the drift is the bug — the
wrong balance is only its symptom.

## Why account snapshots are not here yet

A snapshot needs equity, which needs floating P&L, which needs live quotes. That
logic lives in the API's `AccountStateService`, and it is the single place those
numbers are computed so that the risk engine, the API and the stop-out check cannot
drift apart.

Duplicating it in the worker would create a second definition of equity. The
options are to give the worker a quote reader and share the valuation code, or to
schedule snapshots inside the API where the service already lives. That decision is
open, and until it is made the queue exists with no processor and the startup log
says so.

## Failure handling

`removeOnFail: false` is deliberate: a failed financial job stays in the
dead-letter set until a human has looked at it. Retries use exponential backoff so
a sick dependency is not hammered. Concurrency is 1 per queue — these jobs sweep
whole tables, and a second copy buys nothing while doubling lock contention.

`RUN_JOBS_ON_BOOT=true` runs every scheduled job once at startup. It is a
development convenience and should never be set in production.
