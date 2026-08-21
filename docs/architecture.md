# Architecture

## The one rule everything else follows

**The Trading Engine is the system. The UI is a client.**

Account state, position state, P&L, margin and every order decision are computed
on the server, persisted, and pushed out. The browser renders what it is told.
It never computes a balance, never decides whether a stop-loss fired, and never
holds a value that is not also in PostgreSQL.

This has a practical consequence that shapes the whole repository: the domain
packages (`financial-core`, `trading-core`, `risk-core`) may not import React,
Next.js, NestJS, Prisma, Redis, or Node's I/O modules. That is enforced by an
ESLint rule, not by convention — see `eslint.config.mjs`.

## Layering

```
 Presentation      apps/web, apps/api controllers, WebSocket gateway
        |          (HTTP, JSON, React — no business rules)
        v
 Application       apps/api services, apps/worker jobs
        |          (orchestration, transactions, idempotency)
        v
 Domain            packages/trading-core, financial-core, risk-core
        |          (pure, deterministic, framework-free, fully unit-tested)
        v
 Infrastructure    Prisma, Redis, market-data adapters
```

Dependencies point downward only. The domain does not know that PostgreSQL
exists, which is why its tests need no database and run in milliseconds.

## Runtime topology

```
                         ┌──────────────┐
                         │   Browser    │
                         │  (terminal)  │
                         └──────┬───────┘
                    REST        │        WebSocket
                    ┌───────────┴───────────┐
                    v                       v
              ┌───────────────────────────────────┐
              │              API                  │
              │  controllers · trading engine ·   │
              │  risk engine · market engine      │
              └───┬───────────────┬───────────┬───┘
                  │               │           │
                  v               v           v
           ┌────────────┐  ┌───────────┐  ┌──────────────┐
           │ PostgreSQL │  │   Redis   │  │ MarketData   │
           │ (truth)    │  │ (hot/pub) │  │  Provider    │
           └────────────┘  └─────┬─────┘  └──────────────┘
                                 │
                          ┌──────┴──────┐
                          │   Worker    │
                          │  (BullMQ)   │
                          └─────────────┘
```

**PostgreSQL is the only source of truth for money.** Redis holds the current
quote per symbol, fans WebSocket frames out across API instances, and backs
rate limits and locks. If Redis is wiped, no financial data is lost — the system
reloads its hot state from PostgreSQL and the market feed.

## Applications

| App           | Responsibility                                                                            | Does not                          |
| ------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| `apps/api`    | HTTP + WebSocket surface, trading engine, risk checks, order lifecycle, market ingest     | run long batch work               |
| `apps/worker` | Deferred work: swap accrual, snapshots, reconciliation, idempotency sweeps, notifications | execute orders or close positions |
| `apps/web`    | The trading terminal                                                                      | compute account state             |

Order execution, stop-loss triggering and ledger writes happen **inline in the
API request or the tick handler**, inside a database transaction. They are never
handed to a queue. Specification rule 25 is explicit about this, and it is the
difference between "your stop fired at 4525.79" and "your stop fired whenever
the queue got around to it".

## Packages

| Package              | Contains                                                                        | May import                   |
| -------------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| `@tp/shared-types`   | Enums, wire DTOs, error codes, WS contract                                      | `zod`                        |
| `@tp/financial-core` | `Money`, `Decimal`, rounding, instrument specs, P&L / margin / account formulas | `decimal.js`                 |
| `@tp/market-core`    | `MarketDataProvider` port, clock, seeded RNG, candle aggregation, simulator     | financial-core               |
| `@tp/trading-core`   | Order & position state machines, entities, protective-order logic               | financial-core               |
| `@tp/risk-core`      | Rule interface, rule engine, default rule set                                   | financial-core, trading-core |
| `@tp/api-client`     | Typed REST client, envelope unwrapping, error mapping                           | shared-types                 |
| `@tp/ui`             | Presentation primitives and design tokens                                       | React (peer)                 |

## Extension points

Two seams exist so that future products can be built **on** this platform
rather than inside it:

1. **`MarketDataProvider`** — swap the internal simulator for a broker feed
   without touching the engine.
2. **`RiskRule`** — a rule is a pure function of `(order, context)`. A prop-firm
   product adds drawdown, profit-target and consistency rules by supplying more
   rules. None of that logic belongs in this repository (specification §62).

A third seam, the domain event stream (`DomainEvent` in `@tp/shared-types`), lets
an external product observe trading activity without reading these tables.

## Decisions worth recording

**Money is never a JavaScript number.** Every monetary and price value is a
decimal string on the wire, a `NUMERIC` column in the database, and a
`Decimal`/`Money` in memory. `toDecimal()` refuses a non-integer JS number
outright, because `0.1` is already inexact by the time it reaches us.

**Time is injected.** Nothing calls `Date.now()` inside the domain. A `Clock` is
passed in. Daily resets, swap accrual, session boundaries and order expiry are
otherwise untestable.

**Randomness is seeded.** The market simulator uses a seeded PRNG. The same seed
replays the same market on every machine, which is what makes a trading bug
reproducible.

**Transitions are data.** Order and position state machines are lookup tables.
Nothing assigns `status` directly; illegal moves throw at the attempt rather
than corrupting the ledger downstream.
