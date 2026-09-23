# Reports

A report is a query somebody asks the platform to run, a file it produces, and
a download that expires. `/admin/reports`.

## Why this is not a button

Every other export in the panel writes out **the page on screen**. That is
honest for a hundred rows and quietly wrong for a quarter: somebody asks for
"every closed trade in March", gets the fifty rows the table had paged in, and
has nothing in the file to tell them it is not the answer. A truncated
statement that does not say it is truncated is worse than no statement, because
the difference shows up as a reconciliation that nearly balances.

A real export is minutes of query and megabytes of output. That is not
something an HTTP request should hold open, and it is something somebody wants
to come back for. So: a job, a stored file, and a download.

## The shape, and where it came from

`reports` deliberately copies `kyc_documents`, which had already solved the same
problem — bytes sealed at rest, hash and size in the clear so the row stays
useful after the bytes are gone, the sealing key recorded so a rotation can find
rows without opening them, and a sweep that nulls the content rather than
deleting the record.

A report is evidence that an operator was shown a particular set of rows on a
particular day. The record outlives the file.

| Column                              | Why                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `params`                            | The filters as the request made them, so a file can be explained later. Never a secret.                                                                                                                             |
| `sha256`, `size_bytes`, `row_count` | In the clear. What the file was, after it is gone.                                                                                                                                                                  |
| `content`                           | Sealed. Null before the job runs and after the sweep.                                                                                                                                                               |
| `expires_at`                        | Written by the job that produced the file, so retention is decided once at production rather than re-derived from a setting that may since have changed. A file promised for fourteen days keeps its fourteen days. |

### The kinds

| Kind        | A row is                                         | Windowed on   | Needs               |
| ----------- | ------------------------------------------------ | ------------- | ------------------- |
| `TRADES`    | one closed trade: entry, exit, costs, net profit | exit          | `accounts.read_any` |
| `LEDGER`    | one ledger entry, with the balance after it      | entry         | `accounts.read_any` |
| `AUDIT`     | one recorded action: who, what, before and after | record        | `audit.read`        |
| `ORDERS`    | one order placed, whatever became of it          | **placement** | `accounts.read_any` |
| `POSITIONS` | one position opened, open ones included          | **opening**   | `accounts.read_any` |

Each kind's columns are the matching screen's, in its order, deliberately: an
export that disagrees with the screen it came from starts an argument nobody can
settle.

`AUDIT` ignores an account filter rather than applying one. An audit row is
about an actor and a resource, and most have no account at all — silently
treating an account filter as a row filter would produce a file that looks
complete and is not, which is the failure this whole feature exists to stop. Its
`before` and `after` go out as stored: they are redacted when the row is
written, and redacting again at export would make the file and the audit screen
disagree about what happened.

### Which day, as well as which timestamp

The section below reasons about _which timestamp_ a window is anchored on. It
said nothing about _which timezone_, and the panel had quietly chosen one:

```ts
from: new Date(`${from}T00:00:00.000Z`).toISOString(),
to:   new Date(`${to}T23:59:59.999Z`).toISOString(),
```

An operator picks 1–31 March in a date picker and gets **1 March 00:00 UTC to
31 March 23:59:59.999 UTC**. Every other day in this platform — today's P&L, a
DAY order's expiry, the swap accrual key — is midnight in
`TRADING_SERVER_TIMEZONE`. On a server at UTC+9 those disagree by nine hours:
the first nine hours of 1 March are **missing from a file headed March**, and
nine hours of April are in it.

`TRADING_SERVER_TIMEZONE` is `UTC` in both shipped examples, so this was latent
rather than live — and it stops being latent the moment anybody sets the broker
timezone the knob exists for, which for an FX venue is the normal case.

**A request may now say a date.** `from` and `to` accept either an instant with
an offset — passed through untouched, so an integration keeps exactly the window
it asked for — or a plain `YYYY-MM-DD`, which is resolved to that trading day's
edges in the server's timezone. The panel sends the dates a person picked; the
browser has no business deciding which day the trading server is having.

The end is one millisecond before the next midnight, because the worker's
queries compare with `lte` and a row stamped exactly at midnight belongs to one
report, not two. A month containing a clock change is 743 or 745 hours, and the
tests assert that figure rather than 744.

### The window column is the design, for the last two

The first three kinds are settled things. A closed trade has one time that
matters and numbers that will never change again; so does a ledger entry and an
audit record. An order and a position are not settled, and each carries several
timestamps. Which one the window means is the whole design, and getting it wrong
does not produce an error — it produces a file that looks complete.

**`ORDERS` is windowed on placement.** `created_at` is the only timestamp on an
order that never moves. Anchor the window to `updated_at` instead and asking for
March on the 1st of April and again on the 1st of May returns different rows for
a window that did not change. "Every order placed in March" is a sentence an
operator can act on.

What still moves is said out loud rather than hidden: the _set_ of rows is fixed
by that choice, the _contents_ are not. An order placed on the 31st and still
resting has a `status` and a `filled_volume` that will differ tomorrow. Two
exports of the same window can therefore disagree, and that is the difference
between "which orders were placed" and "what became of them" — for the second,
the closed-trade report is settled by construction.

`rejection_code` is in the file on purpose. A rejected order leaves no trade and
no position behind, so nothing else in this feature can find it, and "why did my
order not go through" is the question an operator is actually asked.

**`POSITIONS` is windowed on opening, so open positions are in the file.**
Windowing on `closed_at` would have been tidier — every row complete, every
number settled — and would quietly answer a different question. A position
opened in March and still open in June belongs in a March report; dropping it
produces a file that balances against nothing and gives no sign of what is
missing. An empty `closed_at` says "still open"; an absent row says nothing.

**There is no unrealized-profit column, and there will not be one.** The
platform knows `current_price` — the last price the engine marked the position
at — so the column would be easy to add and wrong in a specific way: true at the
instant the file was built and never again, printed under a heading that says
March and read in June as a March figure. `current_price` itself is in the file,
because a mark whose date is on the page is evidence. What else goes out is what
is _settled_ about the position: commission, swap, realized profit, margin held.
`reports.test.ts` fails if an unrealized column appears.

Three CHECK constraints keep the status honest: READY must have a file, a hash,
a size, a row count and both timestamps; FAILED must say why; EXPIRED must have
no bytes and a `purged_at`. A row cannot claim to be ready with nothing behind
it.

## Permission is per kind, and it is asked twice

A report is a way of reading rows. It must not become a way of reading rows you
could not read otherwise — so `reports.run` is deliberately **not** enough on
its own to read anything. Every kind names the permission its contents would
have needed on screen (`REPORT_DEFINITIONS` in `@tp/reports-core`), and that
permission is checked when the report is requested **and again when the file is
fetched**.

The second check is the one that is easy to leave out and the one that matters.
A file lives for days. A person's role can change in that time: they move desks,
they are demoted during an investigation, an elevated grant expires. Checking
only at request time means Monday's export is still theirs on Friday, after the
access it was based on is gone. The row is evidence they were once allowed; it
is not a standing grant.

**That check now decides something.** It was inert at first: every built-in role
holding `reports.run` also held `accounts.read_any`, so for the trades and
ledger kinds it never refused anybody. The audit kind changed that —
`PLATFORM_OPERATOR` holds `reports.run` and **not** `audit.read`, so the check
refuses a real request from a real role rather than waiting for a role edit to
give it something to do. That is most of the argument for making `AUDIT` the
third kind rather than the fifth.

The other case it guards is a role an administrator has narrowed, which
`RolesService` allows at runtime. `reports.test.ts` exercises that by taking the
grant off the role in the database, which is exactly the state the roles screen
produces.

A report also belongs to **whoever asked for it**. Not a permission check — a
report is somebody's own query with their filters in it, and sharing files
between operators is a feature nobody has asked for. If it is ever wanted it
should be a deliberate grant with its own audit line, not a side effect of
holding `reports.run`.

## The firm boundary

The job payload carries a report id and nothing else. The tenant is read from
the row, and every query runs inside `withTenant` for that firm — so the Prisma
extension and row-level security both apply exactly as they do in a request.
Putting the tenant in the payload would have made the queue a place where a
wrong value becomes a cross-firm read.

`reports.test.ts` checks this by reading the file: two firms make a deposit in
the same window, and firm A's report contains firm A's and not firm B's.

## A retry must not produce two files

BullMQ retries, and a duplicate publish happens. The claim is a conditional
update from QUEUED to RUNNING: the attempt that changes the row is the attempt
that builds the file, and a second finds nothing to claim and stops. A report
already READY is left alone rather than rebuilt — the file somebody downloaded
must not change underneath them. No lock, no leader, and correct under a retry,
a duplicate publish, and two workers racing.

## When a report stops

Two ways, and they need opposite treatments.

**QUEUED with no job.** `request` writes the row, commits, then publishes —
deliberately in that order, because a job with no row is invisible while a row
with no job is at least on the screen. If the publish fails, or Redis was down,
or no worker was listening on `reports` at that moment, the row sits there
looking like it is about to start.

**RUNNING with no worker.** A process killed mid-build leaves the row claimed,
and _nothing can ever pick it up again_: the claim is a conditional update from
QUEUED, so the mechanism that makes retries safe is exactly what makes a dead
claim permanent. This is the sharper of the two and the one that does not
resolve itself.

`MaintenanceService.recoverStalledReports` handles both, on the existing
retention schedule: a RUNNING row idle for 30 minutes goes back to QUEUED, and
QUEUED rows older than that are re-queued by the queue registry, which owns the
queues. Deciding _which_ is a question about rows and is testable without a
Redis; putting them back on the queue is not.

After six hours a report that is still not finished is marked FAILED with words
an operator can act on, because "try again" cannot be the answer forever. The
bound is the clock rather than an attempt counter — a column to carry for a case
that resolves itself either way.

A finished report is never touched by any of this. A clock does not un-finish
something.

**This section exists because the service's own comment promised the sweep
before the sweep was written.** "The sweep can re-queue it" sat in
`reports.service.ts` justifying the commit-then-publish order, and there was no
sweep. It is the same defect this codebase keeps finding in itself, committed
here by the person who had spent the week finding it elsewhere.

## Bounds, and what happens at them

- **Window**: at most 366 days. A tax year is the largest span anybody asks for
  as one file; wider is better served by several reports that each finish.
- **Rows**: at most 250,000. The file is assembled in memory before it is
  sealed, so an unbounded report is an unbounded allocation in a worker with
  other jobs to run. A report that hits the cap **fails saying so** rather than
  handing somebody a truncated statement and calling it complete.
- **Retention**: `REPORT_RETENTION_DAYS`, 14 by default. The sweep runs with the
  other retention jobs and clears the bytes, leaving the row.

## CSV

The server's CSV and the browser's must agree, because a downloaded statement
and an on-screen export of the same rows have to match. The rules are the
familiar two: RFC 4180 quoting, and formula-injection guarding for a field
beginning `=`, `+`, `-`, `@`, tab or carriage return — a statement is exactly
the kind of file somebody opens in Excel without thinking about it.

There are two copies, `@tp/reports-core/csv` and `apps/web/src/lib/csv.ts`,
because the browser one reaches for `Blob`. `csv.parity.test.ts` imports the
browser's own module and pushes the same inputs through both, sweeping every
plausible leading character rather than a hand-written list — a hand-written
list is how the check rots, and it did: adding `\n` to one guard and not the
other survived the first version of it.

Files carry a UTF-8 BOM. Excel reads a UTF-8 file without one in the local code
page and mangles every non-ASCII name; three bytes is the difference between a
usable statement and a support ticket.

## What is not here

- **Other kinds.** Five today. A sixth is a definition in `kinds.ts`, a query in
  the worker, and an `ALTER TYPE ... ADD VALUE` — the panel and the API need no
  change, because both read the definitions. Deposits and withdrawals as their
  own kind, and a per-account statement, are the obvious candidates.
- **Formats.** CSV only. PDF statements are a different job with a layout
  problem attached.
- **Scheduling.** Every report is asked for by a person. A monthly statement
  that produces itself is a scheduled job and a delivery channel — a phase of
  its own.
- **Sharing.** A report belongs to whoever asked for it. See above.
