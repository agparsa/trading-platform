# Documentation

Phase 0 deliverables — the design the implementation is held to.

**Start here**

- [architecture.md](./architecture.md) — layering, topology, and the one rule everything follows
- [domain-model.md](./domain-model.md) — aggregates, value objects, ubiquitous language, invariants

**Money**

- [pnl.md](./pnl.md) — executable sides, formulas, reference vectors from a live terminal
- [realtime-pnl.md](./realtime-pnl.md) — the account strip, and why absent is not zero
- [margin.md](./margin.md) — margin rate, account state, the two "margin level" numbers

**Trading**

- [trading-engine.md](./trading-engine.md) — submission and tick paths, reliability, restart safety
- [order-lifecycle.md](./order-lifecycle.md) — the order state machine and idempotency
- [position-engine.md](./position-engine.md) — position states, concurrency, SL/TP/trailing
- [risk.md](./risk.md) — rule contract, default rules, the future-product seam

**Interfaces**

- [market-data.md](./market-data.md) — the provider port, determinism, candles, sessions
- [api.md](./api.md) — envelopes, error codes, status mapping, planned surface
- [websocket.md](./websocket.md) — channels, frame shape, sequencing, reconnect
- [terminal.md](./terminal.md) — the browser client: state split, gaps, what it may compute
- [charting.md](./charting.md) — TradingView Advanced Charts and its licensing constraint
- [chart-trading.md](./chart-trading.md) — SL/TP lines, dragging, and the line that never moves
- [one-click-trading.md](./one-click-trading.md) — arming, keyboard keys, and what never fires while typing

**Operations**

- [worker.md](./worker.md) — scheduled jobs: swap accrual, reconciliation, sweeping
- [reconciliation.md](./reconciliation.md) — what is compared, what is never repaired
- [anti-fraud.md](./anti-fraud.md) — integrity signals: observations, never verdicts
- [database.md](./database.md) — schema conventions, the ledger, transactions, indexes
- [security.md](./security.md) — boot refusal, credentials, logging, audit
- [permissions.md](./permissions.md) — the capability catalogue, and why ADMIN cannot trade
- [master-accounts.md](./master-accounts.md) — delegated access, and why an account id is never enough
- [testing.md](./testing.md) — what is covered, reference vectors, what each phase adds
- [observability.md](./observability.md) — logs, metrics, health, what to alert on
- [operations.md](./operations.md) — the kill switch, and why closing is always allowed
- [deployment.md](./deployment.md) — local setup, images, probes, migrations, scaling
- [runbook.md](./runbook.md) — what to do when something is wrong, for whoever is on call
