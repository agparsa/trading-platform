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
