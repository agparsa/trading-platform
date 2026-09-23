# The restore rehearsal

A backup nobody has restored is a hypothesis.

`pnpm restore:rehearse` turns "we take nightly dumps" into a statement about the
business: _if the database is lost at 14:00, this is what we get back and this is
how long it takes._

```
pnpm restore:rehearse                 # dump, restore, migrate, compare, reconcile, drop
KEEP_RESTORE=1 pnpm restore:rehearse  # leave the copy behind to poke at
```

## What it does

1. **Dumps** the live database with `pg_dump -Fc`, timed. Custom format because
   that is what a real backup uses — it compresses and it can be restored in
   parallel. A plain SQL dump would rehearse a procedure nobody runs.
2. **Creates an empty database** beside it. It refuses outright if the target
   name matches the source; that is not a rehearsal, it is an outage.
3. **Restores** into it, timed.
4. **Runs `prisma migrate deploy`** against the copy and requires it to find
   _nothing to do_. A restore that needs migrating is a restore of a schema that
   was already behind — the backup and the code have drifted, and the moment to
   discover that is now rather than during an incident.
5. **Compares** the two.
6. **Reconciles** the copy against itself.
7. **Reports how long** each step took.

## Why row counts are not the check

The obvious rehearsal compares row counts and declares victory. A restore that has
every row and one account a cent short passes that test, and it has lost money.

So the comparison is over **values**: every account's balance, every account's
ledger sum, and an ordered checksum over the identifying and monetary columns of
orders, positions, trades, executions, users and audit logs.

### And for a long time it did not include the wallet

Twelve fingerprints and twenty-three row counts, against a schema of sixty-eight
tables. Among the forty-five nothing looked at were **`wallets`,
`wallet_transactions`, `payment_intents` and `withdrawal_requests`**: a
customer's deposited money, every movement of it, how it arrives and how it
leaves.

`accounts.balance` and `balance_ledger` are the _trading_ account. The wallet is
a separate ledger, and the reconciliation questions asked afterwards are about
ledgers and positions, so they did not reach it either. **A restore that brought
back every trade and dropped a cent from a wallet printed "the restored copy is
identical to the original."**

Two things changed, doing different jobs:

- **Every table is counted now**, generated from `pg_tables` rather than from a
  list. A count needs no knowledge of what a table means, which is exactly why
  it can cover all sixty-eight — so a table a restore loses cannot be invisible,
  including one added next year. Only differences are printed; agreement is a
  single line.
- **The four money tables are fingerprinted by value**, because a count cannot
  see a cent. Proved against the live database: changing one wallet balance by
  0.01 changes the checksum, and rolling back restores it.

`restore-rehearsal-cover.test.ts` asks the _database_ which tables have numeric
columns and requires each to be fingerprinted, with reference and configuration
tables exempted by name and reason. The exemption list is pinned in two files —
found by mutation, when adding `wallets` to the script's own list silenced the
check and nothing failed. An escape hatch with no second opinion is a way of
turning the test off.

Two databases that agree on all of that agree in the way that matters.

## Why the reconciliation engine runs on the copy

The question is not "did the bytes copy". It is "is the restored system
self-consistent" — do balances still equal their ledgers, do positions still have
the executions that opened them, does realized P&L still add up.

The first version of this script asked those questions with its own SQL, and the
SQL was wrong: it looked for executions by `position_id`, a column that does not
exist, because an execution belongs to an _order_. That is the whole argument
against a second definition of a financial invariant (§80), demonstrated on
itself.

It now runs the real `ReconciliationService` — the same checks the scheduled job
runs hourly — against the restored copy. (This sentence said "every night" for
as long as it existed. `RECONCILIATION_CRON` is `15 * * * *`. Nothing turned on
the difference, but a document that is wrong about a schedule is a document
somebody plans an incident around.)

## The rehearsal was tested by breaking the backup

| Fault injected                                              | Caught by                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pg_dump --exclude-table-data=trades`, an incomplete backup | the row count (`5277 → 0`) **and** the trades checksum                      |
| One restored balance a cent out                             | the accounts checksum **and** `LEDGER_DRIFT` from the reconciliation engine |

Both were caught twice, by independent means. That is the property worth having:
the checksum notices that the copy differs, and reconciliation notices that the
copy does not add up, and a fault has to defeat both.

## Measured, on this machine

| Step             | Time     |
| ---------------- | -------- |
| dump (5.5MB)     | 0.7s     |
| restore          | 0.9s     |
| `migrate deploy` | 1.6s     |
| **total**        | **3.1s** |

144 accounts, 10,584 orders, 5,301 positions, 5,277 trades, 5,421 ledger entries.

Those numbers are true of a laptop-sized database on a two-CPU container and
nothing else. Restore time does not scale linearly with size, the production
database will not be 5.5MB, and the number an operator actually needs — _how long
until we are back_ — has to be measured against production volumes on production
hardware. The rehearsal is the thing that tells you; running it is the point.

## What is not rehearsed here

- **Point-in-time recovery.** This restores a dump, not a WAL replay to a chosen
  second. PITR is a different mechanism with a different failure mode and needs
  its own rehearsal against a configured archive.
- **The application coming back up.** The copy is dropped at the end. Pointing the
  API at a restored database and watching it serve is the next rehearsal, and it
  belongs with the deployment procedure rather than here.
- **Where the dump goes.** This writes to a temporary directory and deletes it. A
  backup that lives on the same disk as the database is not a backup; offsite
  copying, retention and encryption at rest are the deployment platform's job and
  are described in [deployment.md](./deployment.md).

## The backup answers where somebody can hear it

The dumps were careful and the _answer_ was not reachable. `backup.sh` verified
every dump with `pg_restore --list` before renaming it into place and pruned
older files only after that passed — both right — and then wrote its verdict to
a one-line `status` file beside the dumps. The runbook said to go and read it.

Which is to say: during an incident, after the backups have already been
silently absent for a week. The backup container is the one scheduled thing in
this deployment that is not a worker job, so the watchdog built for those did
not cover it either.

It now writes into `scheduled_job_runs` like every other schedule, so a backup
that stops or starts failing appears on `GET /health/jobs`, in
`tp_scheduled_job_late`, and in `pnpm verify:production`. Three details:

- **Its schedule is recorded as `every:21600`, not as a cron.** The loop dumps,
  sleeps six hours and dumps again, so a restart shifts every subsequent run and
  there are no fixed slots to be late for. A cron pattern in that column would
  have been a small lie that a reader acts on later, wondering why the dumps do
  not land on the hour.
- **A failure keeps the last success.** The distance between `finished_at` and
  `last_succeeded_at` is how long the backups have been broken, which is the
  only number that answers "how much would we lose".
- **The recording never fails the backup.** A dump that refused to run because
  its bookkeeping row was locked would be a watchdog that eats what it watches.
  If the database is unreachable, no row is written and the existing one goes
  stale — which reads as late, correctly.

The `status` file is still written. Somebody on the host at three in the morning
should not have to query anything.

`backup-script.test.ts` runs the actual shell script against a real database,
including the failure path — `pg_dump` replaced with something that exits
non-zero, which is what a full disk, a dead primary or a revoked role look like
from in there.

## The startup race, and why `depends_on` did not cover it

Production hit this twice before anybody looked:

```text
2026-09-16T02:37  connection to server at "postgres" ... Connection refused
2026-09-18T10:45  could not translate host name "postgres" to address
```

The backup container dumps immediately when it starts. `docker-compose.prod.yml`
has `depends_on: postgres: condition: service_healthy` — and **that is a
startup-ordering directive for one `compose up`, not a runtime dependency.** The
backup container is `restart: unless-stopped`, so when the daemon restarts, or
postgres is recreated beneath it, this container can come back first and dump
into nothing. The second message is the telling one: the name did not resolve at
all, so the postgres container did not yet exist.

Each failure then wrote `FAILED` to `status` and slept six hours, turning a
one-second race into a six-hour-old "the backups are broken" signal. And
`record` needs the same database, so **no row reached `scheduled_job_runs`
either** — the platform could not see the failure it was reporting on disk, and
`/health/jobs` showed the backup as _never run_ rather than _failed_.

`backup.sh` now waits for the database before its first dump, and the wait is
**bounded and startup-only**: a dump six hours in that cannot reach the database
is a real outage and still fails loudly, because waiting there would turn an
incident into silence. `sh backup.sh wait` runs just the wait, which is also the
quickest way for an operator to ask whether that container can see the database.

`sh backup.sh once` deliberately does _not_ wait — somebody running it by hand
wants an answer now.
