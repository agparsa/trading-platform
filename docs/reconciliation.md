# Reconciliation

Four tables record the same events from different angles: orders and their
executions, positions, closed trades, and the ledger. Each is written by its own
code path inside the same transaction, which is what makes them agree. If they
ever stop agreeing, exactly one of those paths is wrong — and the others are the
evidence of it.

## Nothing is repaired

A discrepancy is **detected, recorded and alerted**. Correcting it is a
deliberate, separate, audited act by a person.

```
DETECTED → RECORDED → ALERTED → INVESTIGATED → MANUAL CORRECTION
```

Auto-correcting would destroy the evidence of how the drift happened, which is
the one thing an investigation needs. Worse, it would turn a bug that shows up
once into a bug that quietly cleans up after itself for ever — the balance would
be right every morning and wrong every afternoon, and nobody would know why.

A correction, when a person makes one, is a compensating ledger entry with its
own audit record. The original rows are never touched.

## The checks

| Check                                | Severity | Compares                                                |
| ------------------------------------ | -------- | ------------------------------------------------------- |
| `LEDGER_DRIFT`                       | critical | `accounts.balance` against a replay of `balance_ledger` |
| `REALIZED_PNL_MISMATCH`              | critical | what the trades claim against what the ledger paid      |
| `FILLED_ORDER_WITHOUT_EXECUTION`     | critical | a `FILLED` order with no execution                      |
| `POSITION_WITHOUT_OPENING_EXECUTION` | critical | a position no fill opened                               |
| `POSITION_VOLUME_MISMATCH`           | critical | open volume against `opened − closed` executions        |
| `TRADE_WITHOUT_LEDGER_ENTRY`         | critical | a closed round trip with nothing behind it              |
| `COMMISSION_MISMATCH`                | warning  | commission reported against commission charged          |
| `SWAP_MISMATCH`                      | warning  | swap reported against swap posted                       |

### Three checks that are deliberately absent

The specification lists ten comparisons. Three of them — an execution with no
order, a closing execution with no position, a trade with no position — are
**not** implemented, and that is the right outcome rather than an omission.

Each is a foreign key in this schema. PostgreSQL enforces them on every write,
and re-checking them afterwards would be a check that can never fire — which is
worse than no check at all. It looks like coverage on a dashboard and costs a
query every run.

What is left are the comparisons a database cannot make: sums that must agree,
records that must be backed by ledger entries, and a cached balance that must
equal a replay of the entries behind it.

### The scoping that keeps the alarm meaningful

Two of these would be useless without a qualifier:

- **A resting order has no execution.** That is an order waiting for its price,
  not a fault. `FILLED_ORDER_WITHOUT_EXECUTION` is scoped to filled orders;
  without that it would flag every pending order and bury the one case that
  matters in noise nobody reads.
- **An open position has already paid its entry commission and accrued swap**,
  and no trade row reports either yet. Those costs are added back before the two
  sides are compared. Without it, an account holding a position would show a
  "mismatch" equal to exactly the costs it had legitimately paid.

An engine that flags a healthy account is an engine whose alerts nobody reads,
and by the time it flags a real one it has already trained everybody to ignore
it. So the first test in the suite is that a _correct_ account produces no
findings at all.

## Where the arithmetic lives

`@tp/reconciliation-core` — pure, no database. It takes plain shapes of decimal
strings and returns findings.

That split is what makes the checks testable against a fixture with a cent
deliberately wrong in it. The worker only fetches: it loads one account's
records and hands them over.

The ledger is summed **in PostgreSQL**, by kind, with `SUM(...) FILTER (WHERE
type = ...)`. An account with years of entries should not have every one of them
cross the wire so JavaScript can add them up, and `SUM` over `NUMERIC` is exact —
this is the one place summing money outside `Decimal` is safe, because the total
never leaves the database's own numeric type.

## Reconciliation never blocks trading

The read is deliberately **not** wrapped in a transaction. A serializable read
across every table of a busy account would hold locks against live trading to
answer a question that is not urgent.

The cost is that a trade committing mid-read can produce a transient finding. The
answer to that is to run it again, which is why it is cheap and repeatable rather
than exclusive. Reconciliation must never be the reason an order was slow.

## How this was verified

Each check was broken deliberately, in the pure suite and against a real
database:

| Break                                        | Result                 |
| -------------------------------------------- | ---------------------- |
| Findings computed but never persisted        | 2 tests failed         |
| Open-position costs not added back           | 4 failed               |
| Pending orders flagged as missing executions | 3 failed               |
| Execution side ignored when netting volume   | 1 failed _(see below)_ |

The last one **survived at first**. Every fixture in the worker suite opened a
position and none had ever closed one, so a loader that added every execution
regardless of side produced the same answer as one that netted them — and the
whole point of the volume check is catching a close that wrote its execution but
never took the volume off. A position closed halfway now exists in the suite, and
the mutation fails.

### And the first thing it found was a test

The very first run against the worker's own fixtures reported two critical
findings on an account the previous engine had called clean. It was right: the
swap-accrual tests created positions directly in the database, with no order and
no execution behind them — a shape no code path in this system can produce.

The fixture was fixed, not the check. A test built on a position that cannot
exist is testing against something that cannot happen.

## Runs and findings

Reconciliation used to leave its results as risk events and nothing else. That
made two questions unanswerable: *how long has this been true*, and *did anybody
check*.

### `reconciliation_runs`

One row per pass, written **before** the work starts and closed when it ends —
including when it fails.

Clean runs are recorded too, and that is the point. "The last run found nothing"
and "nothing has run since Tuesday" look identical if only findings are stored,
and only one of them is reassuring. A run that threw is recorded as `FAILED`
with the error, so a broken job cannot masquerade as a clean bill of health.

### `reconciliation_findings`

One row per `(account, code, subject)`, with `occurrences`, `firstSeenAt` and
`lastSeenAt`. A drift still present on the next run is the same drift seen
again, not a second one; a thousand duplicate rows would bury the fact an
investigator actually wants.

`subjectKey` exists because PostgreSQL does not treat two NULLs as equal in a
unique index — a nullable subject would let the same account-wide finding be
inserted without limit. The empty string means "about the account itself".

### Resolution reopens

A finding marked `RESOLVED` or `FALSE_POSITIVE` that is seen again is **reopened**
and its resolution cleared. That is what stops a tick put there in good faith —
when the drift really had gone — from hiding a live inconsistency for longer
than one scheduled run.

### Nothing here repairs anything

Not one method in `ReconciliationReadService` writes to an account, a position, a
trade or the ledger. Correcting a discrepancy is a ledger adjustment through
`AdjustmentsService`: a different route, a different permission, a second factor
and a reason. Keeping them apart is what stops "resolve" from quietly becoming
"make it go away".

### Running one by hand

`POST /reconciliation/runs` creates the run row and publishes a BullMQ job
carrying its id, so the console can show a run that has been *requested* rather
than a button that appears to do nothing. The run id is the job id, so a retried
request cannot queue it twice, and a run already in flight is returned rather
than a second one being started — two concurrent passes over every account would
double the read load to produce the same answer and race each other for the same
finding rows. A run stuck in `RUNNING` for over an hour is treated as abandoned
rather than blocking every future run.
