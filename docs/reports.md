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

| Column | Why |
| --- | --- |
| `params` | The filters as the request made them, so a file can be explained later. Never a secret. |
| `sha256`, `size_bytes`, `row_count` | In the clear. What the file was, after it is gone. |
| `content` | Sealed. Null before the job runs and after the sweep. |
| `expires_at` | Written by the job that produced the file, so retention is decided once at production rather than re-derived from a setting that may since have changed. A file promised for fourteen days keeps its fourteen days. |

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

Worth stating plainly what that check is and is not **today**: every built-in
role holding `reports.run` also holds `accounts.read_any`, so for the two kinds
that exist it never decides anything. It is there for the two cases that are
coming — a kind whose permission is narrower (an audit export needing
`audit.read`), and a role an administrator has narrowed, which `RolesService`
allows at runtime. `reports.test.ts` exercises the second by taking the grant
off the role in the database, which is exactly the state the roles screen
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
and *nothing can ever pick it up again*: the claim is a conditional update from
QUEUED, so the mechanism that makes retries safe is exactly what makes a dead
claim permanent. This is the sharper of the two and the one that does not
resolve itself.

`MaintenanceService.recoverStalledReports` handles both, on the existing
retention schedule: a RUNNING row idle for 30 minutes goes back to QUEUED, and
QUEUED rows older than that are re-queued by the queue registry, which owns the
queues. Deciding *which* is a question about rows and is testable without a
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

- **Other kinds.** Trades and ledger today. Audit, positions and orders are the
  obvious next three; each is a definition in `kinds.ts` and a query in the
  worker.
- **Formats.** CSV only. PDF statements are a different job with a layout
  problem attached.
- **Scheduling.** Every report is asked for by a person. A monthly statement
  that produces itself is a scheduled job and a delivery channel — a phase of
  its own.
- **Sharing.** A report belongs to whoever asked for it. See above.
