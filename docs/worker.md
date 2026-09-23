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

| Queue               | Schedule (default) | What it does                                                                                             | Silence costs                        |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `swap-accrual`      | `0 0 * * *`        | Charges or credits overnight financing on every open position                                            | money, every night                   |
| `reconciliation`    | `15 * * * *`       | Replays every ledger and compares it to the cached balance                                               | drift found by a person, not a check |
| `idempotency-sweep` | `30 * * * *`       | Expired keys, abandoned claims, stale payments, identity-document retention, expired and stalled reports | a data-retention duty                |
| `broker-health`     | `* * * * *`        | Polls each venue connection and ages its credentials                                                     | an expiry nobody sees coming         |
| `outbox-relay`      | `* * * * *`        | Moves committed events out of the outbox                                                                 | every event stops leaving            |
| `webhook-delivery`  | `* * * * *`        | Delivers due webhook attempts                                                                            | deliveries stay due for ever         |
| `reports`           | on demand          | Builds a requested export                                                                                | —                                    |
| `notifications`     | on demand          | Delivers a push notification                                                                             | —                                    |
| `account-snapshot`  | —                  | **No processor yet.** Needs live valuation; see below                                                    | —                                    |

Cron expressions are evaluated in `TRADING_SERVER_TIMEZONE`, not the host's, and
are **validated at boot**: a pattern with the wrong number of fields refuses to
start the container. That is not fussiness. BullMQ's parser accepts some
four-field patterns and shifts the fields — `0 3 * *`, written for "three in the
morning", is accepted, first fires three weeks later and then runs every minute.
Swap accrual charging overnight financing fourteen hundred times a day, with
nothing in any log looking wrong.

Schedules are registered with `upsertJobScheduler`, which is idempotent: a
restart re-registers the same schedule instead of accumulating duplicates the way
a plain repeatable `add` would.

The startup log names the queues that have no processor. A queue that silently
accepts jobs nothing will ever run is worse than one that says so.

## A schedule that stops says nothing

Every other failure in this platform announces itself. An order that cannot be
placed returns an error; a webhook that will not deliver is retried and then
marked failed; a migration that will not apply stops the deploy. **A schedule
that stops produces no error, no failed job and no log line**, because the
process that would have written them never ran. The only evidence is an absence.

It is easy to arrange by accident. `WORKER_ROLE=processor` on every worker
leaves nobody registering schedules, and no single process can detect that —
each is behaving exactly as configured. A Redis flush that takes the scheduler
keys, or a worker that never came back after a deploy, looks identical from
inside: quiet.

So every scheduled run is recorded in `scheduled_job_runs` — one row per job,
holding the last start, the last finish, the last _success_ kept separately, the
outcome, and the totals. From those rows:

| Where                          | What it gives you                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `GET /health/jobs`             | up or down, with a sentence per problem. Alert on it; do not route on it            |
| `tp_scheduled_job_age_ms{job}` | how long since that job last succeeded; `-1` means never                            |
| `tp_scheduled_job_late{job}`   | `1` when it is later than its own cron allows, failing, never run, or misconfigured |
| `pnpm verify:production`       | one check, the only one that can fail on a deployment where everything else passes  |

### Is a worker there _now_?

The rows above say what _ran_. They cannot say what is running: a daily job's
row is yesterday's worker's for a day, and the worker serves no HTTP, so until
21 September it could not be asked — it was the one container that could sit on
last week's image with nothing outside the host able to tell, which is what the
real-time service did for three upgrades before its handshake named its build.

So every worker process writes a heartbeat: one Redis key under
`tp:worker:heartbeat:<host>:<pid>`, holding its instance, role, queues, start
time and build marker, rewritten every thirty seconds with a ninety-second TTL
and deleted on a clean shutdown. Redis rather than the database, deliberately:
this is _presence_, and presence that outlives its process is the failure mode.
A Redis flush costs one interval of "no worker seen"; the next beat repairs it.

`GET /health/jobs` carries a second indicator, `workers`, naming every instance
with its build and how old its last beat is. It is **down when no worker has
reported within the TTL** — nothing is going to run the schedules, and that is
said at once rather than when the first daily job is late tomorrow.
`pnpm verify:production` reads it: a worker is alive, and with `--expect`, every
worker runs the deployed build. The contract both sides use is
`WorkerHeartbeat` in `@tp/shared-types`; `pnpm smoke:worker` reads the real
build's heartbeat from the real Redis and checks the key is gone after SIGTERM.

Three details worth knowing, because each was a decision:

- **The tolerance comes from the job's own cron**, not from a constant. Three
  minutes is catastrophic for the outbox relay and unremarkable for swap
  accrual. It is three intervals plus five minutes of grace, and the interval is
  the **longest** gap over the next few firings — otherwise a weekday schedule
  would report a healthy job as stopped every Saturday.
- **A manual run does not count.** Only the job BullMQ's scheduler adds is
  recorded. Otherwise an operator pressing "run now" _because_ the numbers look
  stale would reset the clock and hide the dead scheduler they were reacting to.
- **A failing job is not a quiet one, and is not healthy either.** The last
  success is kept apart from the last finish, so a job that has run every minute
  and thrown every time for a week reads as failing rather than fresh.

An empty `scheduled_job_runs` reads as **down**, deliberately. That is exactly
what a deployment with no scheduler looks like, and treating it as healthy would
mean the one arrangement this exists to catch is the one it calls fine. A fresh
deployment shows down until its first sweep lands.

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
