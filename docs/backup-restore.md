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
orders, positions, trades, executions, users and audit logs. Two databases that
agree on all of that agree in the way that matters.

## Why the reconciliation engine runs on the copy

The question is not "did the bytes copy". It is "is the restored system
self-consistent" — do balances still equal their ledgers, do positions still have
the executions that opened them, does realized P&L still add up.

The first version of this script asked those questions with its own SQL, and the
SQL was wrong: it looked for executions by `position_id`, a column that does not
exist, because an execution belongs to an _order_. That is the whole argument
against a second definition of a financial invariant (§80), demonstrated on
itself.

It now runs the real `ReconciliationService` — the same eight checks the scheduled
job runs every night — against the restored copy.

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
