# Database

PostgreSQL 16, Prisma 6. Schema: `prisma/schema.prisma`.

## Conventions

- Public identifiers are UUIDs. Sequential keys are never exposed by the API.
- **No floating-point columns exist**, and CI fails if one appears
  (`pnpm check:schema`). 57 `NUMERIC` columns, zero `double precision`.
  - money / prices → `NUMERIC(28,10)`
  - volume (lots) → `NUMERIC(18,8)`
  - percentages → `NUMERIC(10,4)` / `NUMERIC(18,6)`
- All timestamps are `TIMESTAMPTZ`, stored UTC.
- Rows the engine races on carry a `version` column for optimistic concurrency.
- `*_events` tables and `balance_ledger` are append-only.

## Entity map

```
User ──< Account ──< Order ──< OrderEvent
  │         │   │      └──< Execution
  │         │   │
  │         │   ├──< Position ──< PositionEvent
  │         │   │        └──< Trade
  │         │   │
  │         │   ├──< BalanceLedger        (append-only)
  │         │   ├──< AccountSnapshot
  │         │   └──< RiskEvent
  │         └─── AccountSettings (1:1)
  └──< RefreshToken
  └──< AuditLog

Symbol ─── SymbolSpec (1:1)
   └──< MarketSession
   └──< Order / Position / Trade

Candle            (composite PK: symbolCode + resolution + time)
IdempotencyKey    (unique: scope + key)
RiskRuleConfig
```

## The ledger is the truth

`balance_ledger` is append-only. Nothing updates or deletes a row; a mistake is
corrected with a compensating `ADJUSTMENT` entry that references the original
via `compensatesId`.

`accounts.balance` is a **cache** of the ledger's running total, kept current
inside the same transaction that writes the entry, and reconciled against the
ledger by a scheduled job. When the two disagree, the ledger wins.

`balanceAfter` is stored on every entry so any historical balance is a single
row read rather than a replay of the whole account.

`idempotencyKey` on the ledger is unique: a retried webhook or job cannot
double-credit an account.

### Round once, then apply what was rounded

The stored `amount` is the number that moves the balance. Not a rounded copy of
it — the same number.

This sounds like pedantry and is not. `post()` originally stored
`amount.round()` and separately computed `(before + amount).round()`, which is
the obvious spelling and rounds twice, independently. Whenever a posting did not
land on a cent — a commission of 0.175, which is what 0.05 lots of a major pair
actually costs — the two disagreed: the row said 0.18 while the balance moved
0.17. Every account that had ever paid a fractional commission drifted by a cent
per trade.

Nothing would have caught it except the reconciliation job, reporting drift with
no cause to point at, long after the trades that caused it. It was found by
reading a real account's entries down the page and noticing that they did not
add up to the balance printed beside them.

The invariant now holds by construction: every stored amount is rounded, and the
balance is a previous balance plus a stored amount, so `balance` is exactly
`SUM(amount)` for ever. The sum is deliberately _not_ rounded a second time —
doing so would reopen the same gap.

The same rule applies one level up, where closing a position writes both a trade
row and several ledger entries. Each component — gross, entry commission, exit
commission, swap — is rounded once, at the point it is computed, and `netPnl` is
derived from those rounded numbers. Rounding at the point of _use_ instead reads
identically and is not: the ledger would move by
`round(gross) − round(commission) + round(swap)` while the trade row recorded
`round(gross − commission + swap)`, and those differ by a cent whenever a
component lands off one. A trade report that disagrees with the ledger by a cent
is a dispute nobody can settle — and realized P&L on the terminal is summed from
those rows.

**A partial close takes its share; the last close takes the remainder.** The
entry commission was charged once, on the whole position. Rounding each share on
its own invents money: three closes of a third of a 0.05 commission round to 0.02
apiece and sum to 0.06 — a cent that was never charged, appearing in a report as
though it had been. The final close is given whatever is left instead, so the
shares sum to the charge exactly whatever the arithmetic in between.

**Every trade writes a trade-result entry, including one that rounds to zero.** A
break-even round trip is still a round trip, and "every trade has a ledger entry"
is one of the reconciliation checks this platform owes itself. Making it "every
trade except the break-even ones" turns a rule into a rule with an exception, and
the exception is where a genuinely missing entry would hide. A `0.00` line is
honest; an absent one is not.

## Transaction boundaries

Opening a position writes, in one transaction:

```
orders ← the order row
order_events ← CREATED, ACCEPTED, FILLED
executions ← the fill, with the exact quote used
positions ← the new position
balance_ledger ← COMMISSION
accounts ← balance and version
```

Partial success is not a state this system can end up in.

## Migrations

`prisma migrate dev` locally, `prisma migrate deploy` in CI and production. The
production schema is never edited by hand. Every change is a versioned migration
file in `prisma/migrations/`, committed alongside the code that needs it.

## Indexes

Hot paths are indexed explicitly rather than left to chance:

- `orders(symbolId, status)` — the trigger engine's scan for resting orders
- `positions(accountId, status)` and `positions(symbolId, status)` — mark-to-market
- `trades(accountId, exitTime DESC)` — closed-trade history
- `balance_ledger(accountId, createdAt DESC)` — statements
- `candles(symbolCode, resolution, time DESC)` — chart backfill

## Lock ordering

Writes to one account serialise on its row. That is deliberate — the
`SELECT … FOR UPDATE` in `LedgerService.post` is what makes ten concurrent
deposits total the right number instead of the wrong one.

What was not deliberate was the **order** in which locks were taken. Inserting an
order, an execution or a position takes a `FOR KEY SHARE` lock on the parent
account row; PostgreSQL does that automatically for the foreign key. The ledger
post then wanted the same row `FOR UPDATE`. Two concurrent orders on one account
therefore each held a share lock and each waited for the other's exclusive lock —
a cycle, which PostgreSQL breaks by killing one transaction with
`40P01 deadlock detected`.

A load test found it: eight of ten simultaneous orders on one account failed, and
the trader was told "an unexpected error occurred". Two quick clicks could have
done the same.

**The rule now: any transaction that will post to the ledger takes the account's
write lock first, before any insert that references the account.**
`LedgerService.lockAccount` exists for exactly that, and is the first statement of
`openPosition`, `fillPending` and `close`. A second transaction then blocks at the
top holding nothing, so there is no cycle to detect.

The effect, measured on the same burst:

|                                             | Before   | After     |
| ------------------------------------------- | -------- | --------- |
| Orders succeeding (10 at once, one account) | 2        | **10**    |
| p50 latency                                 | ~5,000ms | **295ms** |
| Deadlocks                                   | 8        | **0**     |

Verified by putting it back: removing the up-front lock reproduces `40P01` in the
integration suite.

## When contention is not a fault

A queued write that runs out of budget, loses a connection race, or is chosen as
a deadlock victim has changed nothing and will very likely succeed on retry. Those
are reported as `CONCURRENT_MODIFICATION` with a message saying so — not as
`INTERNAL_ERROR`, which tells the trader nothing and sends the operator looking
for a bug that is not there.

`DATABASE_TRANSACTION_TIMEOUT_MS` and `DATABASE_TRANSACTION_MAX_WAIT_MS` bound
how long a queued write waits. Prisma's 5s default expired transactions that were
only waiting their turn.
