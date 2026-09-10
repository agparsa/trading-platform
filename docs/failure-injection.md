# Failure injection

`pnpm chaos` (after `pnpm build`). §75.

The question is not "does the platform stay up". It is "does the money stay
right". Each scenario breaks something underneath a running API while orders
are in flight, restores it, and checks the one invariant a trading platform
must never lose, however it was treated:

> every account's balance equals the sum of its own ledger, every order that
> was accepted produced exactly one fill — never none, never two — and every
> fill has an idempotency record that says so.

Latency is printed. Only the invariant, and a refusal that is not a coded
envelope, fail the run. A slow order under a severed database is capacity; a
doubled fill is a defect.

## How it breaks things

Postgres and Redis are reached through a small TCP proxy the script runs on
`:15432` and `:16379`. The proxy can add latency to every packet, sever every
live connection at once, or refuse new ones — without touching either server.
The API is the compiled build, in two instances as production runs (one
ingests, one serves), killed with `SIGKILL` where a scenario needs it: a
process asked nicely to stop is not the failure being tested.

Instances are booted one at a time. Booting reconciles roles for every tenant,
and each tenant touched opens a pool that is only evicted after a grace period;
on a database that has seen thirty pentest tenants that is forty connections
per instance for a few seconds, and two at once exhausted a local Postgres
before anything had been injected.

## The scenarios

| Scenario                                        | What happens                                                                                                     | What held                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline                                        | 40 orders, nothing broken                                                                                        | the invariant, and numbers to compare against                                                                                                                           |
| **API killed mid-burst**, same keys retried     | `SIGKILL` at 1.2 s into a 1.4 s burst; restart; retry twice, once immediately and once after the takeover window | 26 claims `COMMITTED` → refused `IDEMPOTENCY_RESULT_UNAVAILABLE`; 14 `IN_PROGRESS` → refused in flight, then taken over and filled once; fills = accepted, none doubled |
| **Every database connection severed** mid-burst | ~170 connections destroyed while 40 orders commit                                                                | 38 filled, 2 refused with a coded `INTERNAL_ERROR`; nothing half-applied; the pool reconnected and the next burst was ordinary                                          |
| **Database 150 ms late**                        | every packet delayed                                                                                             | orders fill slowly, or are refused `STALE_QUOTE` — either is right; never a fill at a price the platform no longer trusted                                              |
| **Redis unreachable** for 8 s                   | connections refused                                                                                              | every order `STALE_QUOTE` (quotes reach the serving instance over Redis); fills resume within seconds of Redis returning                                                |
| **Market data leader dies**                     | the ingest instance killed; 16 s pass                                                                            | every order `STALE_QUOTE`; not one fill on a stopped feed; fills resume once a new leader ingests                                                                       |
| **API asked to stop** (`SIGTERM`) mid-burst     | the signal lands while 40 orders are in flight                                                                   | 40 filled, 0 refused; the process exited 1.8 s after the signal; the invariant held                                                                                     |

## What it found

**The crash between commit and record.** The first run with the kill timed to
land while orders were committing showed 39 of 40 fills with claims still
`IN_PROGRESS`. Every retry with the same key was refused as "still in flight";
a client following the only path left — a fresh key — would have filled each
again. The claim is now marked `COMMITTED` _inside_ the operation's
transaction, and a retry is refused with a code that says "applied, read the
account". See [order-lifecycle.md](./order-lifecycle.md#the-claim-commits-with-the-money).

**Stopping was not graceful.** `enableShutdownHooks()` ran `app.close()` on
`SIGTERM`, and `app.close()` destroys the modules — Prisma disconnects — before
it stops accepting HTTP. The first run of this scenario filled 4 of 40 orders;
36 failed with `CONCURRENT_MODIFICATION` after ten seconds because their
transactions lost the connection under them, and the process took 14.6 s to
exit. Nothing was half-applied (the transactions rolled back), so the ledger
held, but a deploy would have failed most of the orders in flight at that
moment. The API now drains first: newcomers get `503` with `Retry-After`, the
requests already inside finish, and only then do the modules close. After the
change: 40 filled, 0 refused, exit 1.8 s after the signal. See
[runbook.md](./runbook.md#draining).

**Ingest waits on the database.** With the database slow, the ingest
instance's tick pipeline falls behind, the serving instance's quotes age past
`QUOTE_MAX_AGE_MS`, and the platform stops pricing. That is availability lost
safely — §26 kept — and it is reported so somebody can decide whether ingest
should wait on the database at all.

**About forty-five database messages per order.** Counted at the proxy while
four orders were in flight on a slow database. At a local round trip it is
invisible; at 5 ms — a managed database in another zone — it is a quarter of a
second per order. Reported, not fixed.

## What is not here, and why

- **Duplicate, missing and out-of-order broker events.** Exercised against the
  mock venue in `broker-inbox.test.ts` and the external-execution suite, where
  the sequence is controlled exactly. Replaying them through a socket would
  test the socket.
- **Worker crash mid-delivery.** The outbox relay and webhook deliverer are
  idempotent by construction (`skipDuplicates` against a partial unique index,
  the claim-as-lease) and tested as such. A local webhook receiver cannot be
  used here: the sender refuses private addresses, and there is deliberately
  no configuration that turns that off.
- **Assertions on latency.** A threshold that passes on this machine and fails
  on a busy runner teaches nobody anything.
