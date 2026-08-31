# Documentation

Phase 0 deliverables — the design the implementation is held to.

**The audit against the master specification**

Eight documents produced by inspecting the repository, not by recalling it.
Start with the architecture audit; the plan sequences everything the audit
found missing.

- [ARCHITECTURE_AUDIT.md](./ARCHITECTURE_AUDIT.md) — what exists, what works, what is missing outright
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — sixteen phases, dependencies, honest estimates
- [API_INVENTORY.md](./API_INVENTORY.md) — all 84 routes with the permission each demands, generated from source
- [DATABASE_AUDIT.md](./DATABASE_AUDIT.md) — 29 models, zero float columns, and the tenancy problem
- [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) — controls located in source, seven findings
- [TRADING_AUDIT.md](./TRADING_AUDIT.md) — orders, positions, risk, the trigger loop, and what is simulated
- [MOBILE_AUDIT.md](./MOBILE_AUDIT.md) — there is no mobile application; what it would take
- [ADMIN_AUDIT.md](./ADMIN_AUDIT.md) — seven panels, all real, and six findings

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
- [multi-tenancy.md](./multi-tenancy.md) — how one platform holds several firms, and where the boundary is enforced
- [security.md](./security.md) — boot refusal, credentials, logging, audit
- [two-factor.md](./two-factor.md) — TOTP proved against the RFC, and why a code works once
- [encryption-at-rest.md](./encryption-at-rest.md) — the secret box, and the row a ciphertext is bound to
- [sessions.md](./sessions.md) — where you are signed in, and what is deliberately not collected
- [registration.md](./registration.md) — who may open an account, and why production refuses to boot open
- [penetration-checklist.md](./penetration-checklist.md) — attacks attempted, and the two gaps it found in itself
- [permissions.md](./permissions.md) — the capability catalogue, and why ADMIN cannot trade
- [master-accounts.md](./master-accounts.md) — delegated access, and why an account id is never enough
- [testing.md](./testing.md) — what is covered, reference vectors, what each phase adds
- [soak.md](./soak.md) — what a leak looks like, and why a slope needs a fit
- [final-audit.md](./final-audit.md) — the browser, concurrency and integration pass, and the margin race it found
- [backup-restore.md](./backup-restore.md) — the rehearsal, and why row counts are not the check
- [observability.md](./observability.md) — logs, metrics, health, what to alert on
- [operations.md](./operations.md) — the kill switch, and why closing is always allowed
- [deployment.md](./deployment.md) — local setup, images, probes, migrations, scaling
- [runbook.md](./runbook.md) — what to do when something is wrong, for whoever is on call
