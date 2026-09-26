# Runbook

What to do when something is wrong, written for whoever is on call at the time —
which may be someone who has never read the rest of these documents.

The one rule that overrides everything below: **never repair the ledger by
editing it.** It is append-only, and a correcting entry is how a mistake is
fixed. A `balance` that disagrees with the sum of its entries is evidence; erasing
it destroys the only record of what went wrong.

The database now enforces this rather than asking you to remember it: `UPDATE`,
`DELETE` and `TRUNCATE` on `balance_ledger` raise `42501` and tell you to post a
compensating entry. If you find yourself reaching for `ALTER TABLE … DISABLE
TRIGGER` at three in the morning, that is the moment to wake somebody else up
instead.

## First five minutes

```bash
curl -s localhost:4000/health          # process is alive, and which build it is
curl -s localhost:4000/ready           # database and Redis are reachable
curl -s localhost:4000/metrics | head  # counters are moving
```

From anywhere, with no shell on the box — which is the case more often than it
should be:

```bash
pnpm verify:production                 # the public surface over HTTPS, no credentials
```

`/ready` failing while `/health` passes means the process is up but a dependency
is not. That is the usual shape of an outage, and it tells you where to look.

## Symptoms

### Traders say prices are frozen

The feed has stopped. Check `tp_market_ticks_total` twice, thirty seconds apart.

If it is not rising: exactly one process must ingest market data
(`MARKET_INGEST_ENABLED=true`), and if that instance died no other one took over.
Start one. Two would double-count candle volume, so do not simply set it on every
replica.

If it _is_ rising, the feed is fine and the sockets are not — see below.

### Traders say the terminal is stale but prices move

The WebSocket is delivering nothing, or the client has lost its connection and is
showing what it last received. The terminal's connection badge is never
optimistic: if it says `Live`, frames are arriving now.

Check `tp_websocket_connections_total`. A large `disconnect` count against a small
`connect` count is a proxy or load balancer closing idle upgrades — raise its
timeout rather than restarting the API.

### Stops are firing late

Check `tp_ticks_coalesced_total`. A rising rate means the trigger engine is
running behind the feed. **Nothing is being lost** — coalesced ticks are
evaluated against their extremes, so a level the market traded through still
fires — but detection is delayed by however long a pass takes.

The pass is database-bound. Look at connection pool saturation and slow queries
before anything else.

### Orders are failing with CONCURRENT_MODIFICATION

Contention, not a fault: nothing was written and a retry will very likely work.
It means several writes are queuing on one account's row, which is the lock that
keeps balances correct.

If it is constant rather than bursty, raise `DATABASE_TRANSACTION_TIMEOUT_MS` and
the pool size (`connection_limit` on `DATABASE_URL`). Every queued transaction
holds a connection while it waits, so the pool must be larger than the expected
queue depth, not merely larger than the core count.

### Orders are failing with SERVICE_UNAVAILABLE

The instance is refusing at its concurrency limit (`HTTP_MAX_IN_FLIGHT`,
default 512 requests in flight) or it is draining for a restart. Either way
nothing was changed and the response carries `Retry-After`. A burst that clears
in seconds is the control doing its job — the alternative was accepting more
than the loop could serve, until connections reset with no answer at all.
Sustained, it means the instance is undersized for the traffic: add an instance
behind the edge before raising the limit, and read the boot log's
connection-budget line first, because every instance takes its share of the
database's connections. The warning `Refused N request(s) at the concurrency
limit` is logged at most once every ten seconds while it is happening.

### Orders are failing with INTERNAL_ERROR

This is a bug, not load. Find the `requestId` in the trader's error response and
grep the logs for it; every request carries one end to end. One exception worth
knowing: `Too many database connections opened` in that log means the
connection budget was exceeded — the boot log says what this instance may open
and what the server allows; lower `DATABASE_TENANT_POOLS` or `connection_limit`,
or run fewer instances against that database.

### An account's balance looks wrong

Do not adjust it. Replay the ledger:

```sql
SELECT SUM(amount) FROM balance_ledger WHERE account_id = $1;
SELECT balance FROM accounts WHERE id = $1;
```

The reconciliation job compares these hourly and **records** drift without
repairing it. If they disagree, the sum is the truth and the cached balance is
the symptom. Find the transaction that produced the drift before changing
anything.

### A position will not close

Check its status. `CLOSING` means a close is in flight and holding the claim; it
is released when that attempt finishes or fails. A position stuck in `CLOSING`
means a process died mid-close — the trade did not happen, and the position
returns to `OPEN` on the next attempt.

`SUSPENDED` accounts cannot trade at all, which is often the real answer.

### The trigger engine is not firing anything

`TRIGGER_ENGINE_ENABLED=false` disables stop-loss and take-profit entirely. It is
not a performance knob, and the API logs a warning at boot when it is off. Check
that first.

### Nobody can open the admin panel

Every screen under `/admin` answers 403 for everyone. Either there is no
administrator — a fresh deployment has none, and nothing creates one — or the
only one has gone. Both are the same act at the host:

```bash
./scripts/first-administrator.sh --email you@firm.example --reason "..."
./scripts/first-administrator.sh --email ... --reason "..." --even-if-one-exists   # the last one left
```

The person must already be registered and verified. The act ends their sessions
and is written to the audit log with the host's name; see
[deployment.md](./deployment.md#the-first-administrator).

## Deploys

### Migrations

`prisma migrate deploy` runs forward only and is safe to run on a live database
for additive changes. A migration that drops or narrows a column is not; take the
API down first, because the running instance is still writing the old shape.

**A migration that stops the deploy has usually done its job.** The compose file
runs migrations as a job every other container waits for, so a failure leaves
the old containers serving and nothing half-applied. Two of them refuse
deliberately rather than because something is broken:

- `a_withdrawals_hold_must_exist` counts withdrawals naming a wallet movement
  that does not exist, or one from another wallet, and stops with that count in
  the message. Those rows are withdrawals whose money cannot be accounted for.
  Investigate them; do not drop the constraint to get the deploy through.
- `truncate_is_a_deletion_too` and `append_only_means_the_database_refuses` add
  triggers, so they cannot fail on existing data — but afterwards `UPDATE`,
  `DELETE` and `TRUNCATE` on the ledger and ten other tables raise `42501`. If
  you find yourself reaching for `ALTER TABLE … DISABLE TRIGGER` to make a
  problem go away, that is the moment to wake somebody else up instead.

Run `pnpm migrate:rehearse` before a deploy. It applies the whole chain against
a scratch database from a fresh install **and from every "production is N
behind" position**, and checks the result matches `schema.prisma`. Five or six
minutes. It needs an owner connection, so it is a developer's command rather
than something the deploy runs.

It used to check the last three positions only, and in September production was
eight migrations behind — so the position that actually mattered had never been
rehearsed. Worse, the way it built a "behind" database did not work at all: it
used `PRISMA_MIGRATIONS_PATH`, which Prisma ignores, so every one of those runs
was a fresh full install reporting itself as something else. It now counts
`_prisma_migrations` before and after and fails if the numbers disagree with
what it claimed, so a setup step that quietly does something else stops the run
instead of decorating it.

`MIGRATION_REHEARSAL_CUTS=3` shortens it while iterating. The output says
loudly when a run was partial; do not deploy on one.

### Rolling back

Roll back the **image**, not the migration. Reversing a migration means deciding
what happens to the rows it created, and that is a decision to make
deliberately rather than at 3am.

**How far back is safe: to any image released after
`20260831140000_multi_tenancy`.** An older image runs against a newer schema
and writes the _older_ shape of every row, so this works exactly as long as
every migration in between is additive. Two are not — they add `NOT NULL` to
columns that already existed:

| Migration                                   | What narrowed                                       |
| ------------------------------------------- | --------------------------------------------------- |
| `20260824190000_trade_commission_breakdown` | `trades.entry_commission`, `trades.exit_commission` |
| `20260831140000_multi_tenancy`              | `tenant_id` on every scoped table                   |

An image from before either of those writes rows without those columns, and the
insert is refused — so a rollback across one turns a bad deploy into a broken
one. Rolling back that far means restoring a backup, not pulling an older tag.

This used to read "every migration in this repository is additive so far",
which was simply wrong, and wrong in the direction that costs you an outage.
`scripts/migrations.test.ts` now fails the build if a migration narrows the
schema without being recorded, and fails it again if the floor named above
stops being the newest one — so this paragraph cannot go stale without somebody
being told.

#### The second floor: what an older image cannot _read_

Narrowing is about writes. There is a second hazard, the opposite shape and just
as final: **a migration that adds a value to an enum**. The schema gets wider,
every write an old image makes still succeeds — and the moment one row carries
the new value, an old image cannot read it.

Measured rather than argued. A Prisma client generated from the schema as it
stood before `ORDERS` existed, pointed at a database holding one report with
`kind = 'ORDERS'`:

|                         |                                   |
| ----------------------- | --------------------------------- |
| raw SQL                 | `[{"kind":"ORDERS"}]`             |
| old client `findUnique` | `PrismaClientUnknownRequestError` |
| old client `findMany`   | `PrismaClientUnknownRequestError` |

`findMany` is the one that matters. It is not one unreadable row, it is the
**whole list** — roll back across this with a single such report in the table
and the reports screen does not degrade, it throws. And PostgreSQL has no
`ALTER TYPE … DROP VALUE`, so the database half cannot be undone at all.

**The newest of these is `20260926090100_order_event_unconfirmed`
(`OrderEventType: UNCONFIRMED`).** An order sent to an external venue whose
answer is lost writes one, so the floor bites only once a venue-executed order
has lost an answer; a platform on the internal engine alone never writes it.
Thirteen migrations since 26 August add enum values; `ADDS_ENUM_VALUES` in `scripts/migrations.test.ts` lists every one with
what it introduces, checked both ways, and the build fails if this paragraph
stops naming the newest.

Unlike narrowing, this hazard is **data-dependent**, and the difference is worth
keeping in mind at 3am: a narrowing migration breaks a rollback always; this one
breaks it only once somebody has created a row using the new value. A platform
where nobody has yet run an `ORDERS` report can still roll back past it. There
is no way to check that from the image you are rolling back to, which is why the
floor is stated at the migration rather than at the data.

### Draining

**API.** `SIGTERM` (or `SIGINT`) puts the process into a draining state
_before_ anything is closed:

1. New requests are refused with `503 SERVICE_UNAVAILABLE`, `Retry-After: 2` and
   `Connection: close`, so a load balancer or client retries against another
   instance. Probes are refused too — that is the point; the orchestrator stops
   routing to this pod.
2. Requests already inside the process run to completion. An order that was
   half-way through its transaction when the signal arrived commits normally —
   the idempotency claim commits with the money, so a retry after restart gets
   the stored result rather than a duplicate fill.
3. When the last in-flight request finishes (or `SHUTDOWN_DRAIN_TIMEOUT_MS`,
   default 25 000, elapses), idle keep-alive sockets are closed, then `app.close()`
   runs the module hooks: market feed, tick consumers, Redis, database.

Under load (`pnpm chaos`, scenario "the API is asked to stop mid-burst") the
process exits well under two seconds after `SIGTERM` with every accepted order
filled once. Before this, `app.close()` disconnected Prisma while requests were
still running and most of the burst failed with `CONCURRENT_MODIFICATION`.

Give the container `SHUTDOWN_DRAIN_TIMEOUT_MS` plus a few seconds before
`SIGKILL` — `stop_grace_period: 40s` in the compose files. If the drain deadline
passes with requests still in flight the log line `drain: abandoning N request(s)`
tells you how many were cut off; they are safe to retry by idempotency key.

**Worker.** Shutdown hooks drain in-flight BullMQ jobs and then close Redis and
the database. Allow at least 30 seconds; the default 10 can cut a swap-accrual
run in half.

## What is safe to restart

| Component  | Safe to restart?   | Why                                                                                                                                    |
| ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| API        | Yes                | Stateless. It drains first (below).                                                                                                    |
| API (ws)   | Yes                | `api-ws` holds the sockets; they reconnect and re-snapshot, which the client contract requires. Restart it off-peak if you can.        |
| Worker     | Yes                | Jobs are idempotent and BullMQ redelivers.                                                                                             |
| Redis      | Yes, with a caveat | It carries no financial truth — quotes are re-published on the next tick and clients re-snapshot. In-flight WebSocket fan-out is lost. |
| PostgreSQL | Only deliberately  | It _is_ the financial truth. Restore from backup rather than improvising.                                                              |

## A job in the dead-letter set

`DeadLetterNotEmpty` pages when something gave up in the last day.
`DeadLetterBacklog` warns when the set is not empty and nothing new has failed —
that is a backlog somebody was supposed to clear.

Queues keep failures on purpose (`removeOnFail: false`): a financial job that
exhausted its retries stays visible until a person has looked at it. Nothing
removes one automatically, and that includes the job succeeding later.

**Read them first.** `tp_dead_letter_depth{queue}` says how many;
`tp_dead_letter_newest_age_ms{queue}` says how long since the most recent. Then,
on the host:

```bash
Q=reconciliation   # the queue the alert named
docker exec trading-platform-prod-redis-1 redis-cli ZCARD "bull:$Q:failed"
# The newest three, with the reason each gave up:
for id in $(docker exec trading-platform-prod-redis-1 \
      redis-cli ZREVRANGE "bull:$Q:failed" 0 2); do
  docker exec trading-platform-prod-redis-1 \
    redis-cli HMGET "bull:$Q:$id" name failedReason finishedOn
done
```

**Decide, then clear.** A failed job is evidence; deleting it without reading it
throws away the only record of what happened. Once the reason is understood and
either fixed or written down:

```bash
# Clears failures older than the given age in ms. 0 clears all of them.
docker exec trading-platform-prod-api-1 node -e "
  const { Queue } = require('bullmq');
  const q = new Queue(process.env.Q, { connection: { url: process.env.REDIS_URL } });
  q.clean(0, 1000, 'failed').then((ids) => { console.log('cleared', ids.length); return q.close(); });
"
```

**Do not retry blindly.** Some of these jobs are financial and some are not
idempotent in the state they failed in. Re-queue deliberately, one at a time,
after reading the reason.

This section exists because the gauge's first scrape on production found 45 —
every scheduled reconciliation between 31 August and 2 September, from a fault
fixed on the 2nd, sitting where nobody could see them and nobody had been told
to look.

## Rotating the encryption key

The full procedure is in
[encryption-at-rest.md](./encryption-at-rest.md#rotating-a-key). The one line
worth carrying here, because getting it wrong is unrecoverable:

```bash
pnpm rotate:secrets --assert-current   # must exit 0 before any key is dropped
```

A key dropped while rows are still sealed under it makes those rows unreadable
for good, and the failure appears weeks later, one person at a time. The check
opens nothing and needs no key, so it is safe to run at any time by anybody who
can reach the database.

## Backups

The `backup` service dumps the database every six hours by default. It writes a
one-line `status` file beside the dumps **and** a row in `scheduled_job_runs`,
so you do not have to be on the host to find out: a backup that stops or starts
failing shows up on `GET /health/jobs`, in `tp_scheduled_job_late{job="backup"}`
and in `pnpm verify:production`, like any other schedule.

If you are already on the host, `status` is still the fastest answer; `FAILED`
there, or a stale file, is the first thing to check. The restore, in order and with the measured numbers, is
[disaster-recovery.md](./disaster-recovery.md). What matters here: a restore has
to be **rehearsed** (`pnpm restore:rehearse`), and the rehearsal has to include
replaying the ledger against the restored `accounts` table. A backup nobody has
restored is a hope, not a backup.
