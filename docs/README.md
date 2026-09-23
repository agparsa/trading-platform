# Documentation

Phase 0 deliverables — the design the implementation is held to.

**The audit against the multi-broker specification (3 September 2026)**

- [architecture-audit.md](./architecture-audit.md) — the repository against the current specification: what exists, what is short, what is absent, and the extension point for each
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — sixteen phases numbered as the specification numbers them, dependencies, honest estimates, and where the work is blocked on a broker's API
- [COMPLETION_STATUS.md](./COMPLETION_STATUS.md) — what is built, tested and running, measured rather than remembered; its figures are generated
- [upgrade-plan.md](./upgrade-plan.md) — the master upgrade's current-state audit and the plan it produced

**The earlier audit, against the standalone-platform specification (August 2026)**

Eight documents produced by inspecting the repository, not by recalling it.
Kept as history; several things they call missing now exist.

- [ARCHITECTURE_AUDIT.md](./ARCHITECTURE_AUDIT.md) — what existed, what worked, what was missing outright
- [API_INVENTORY.md](./API_INVENTORY.md) — every route with the permission each demands, generated from source and checked on every build
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
- [wallet.md](./wallet.md) — money held for a person in no trading account, and the invariant between the two ledgers
- [payments.md](./payments.md) — money coming in: the provider port, the state machine, a real bank transfer, no invented adapter
- [withdrawals.md](./withdrawals.md) — money going out: held at request, reviewed, re-checked at approval, never shown as spendable twice
- [kyc.md](./kyc.md) — proving who a person is, once, so money can be paid to them; sealed documents and their retention

**Trading**

- [trading-engine.md](./trading-engine.md) — submission and tick paths, reliability, restart safety
- [order-lifecycle.md](./order-lifecycle.md) — the order state machine and idempotency
- [position-engine.md](./position-engine.md) — position states, concurrency, SL/TP/trailing
- [risk.md](./risk.md) — rule contract, default rules, the future-product seam
- [desks-and-risk-hierarchy.md](./desks-and-risk-hierarchy.md) — master accounts, what a delegation confers, and the four layers of ceilings
- [external-execution.md](./external-execution.md) — how an order reaches a venue, and what happens when the answer does not come
- [price-alerts.md](./price-alerts.md) — "tell me when gold reaches 4600", and when it fires

**Interfaces**

- [market-data.md](./market-data.md) — the provider port, determinism, candles, sessions
- [api.md](./api.md) — envelopes, error codes, status mapping, planned surface
- [websocket.md](./websocket.md) — channels, frame shape, sequencing, reconnect
- [terminal.md](./terminal.md) — the browser client: state split, gaps, what it may compute
- [charting.md](./charting.md) — TradingView Advanced Charts and its licensing constraint
- [chart-trading.md](./chart-trading.md) — SL/TP lines, dragging, and the line that never moves
- [one-click-trading.md](./one-click-trading.md) — arming, keyboard keys, and what never fires while typing
- [uiux.md](./uiux.md) — the trading screen: what it does, why, and what it deliberately does not
- [web-routes.md](./web-routes.md) — every screen's address, checked against the application
- [accessibility.md](./accessibility.md) — what has been checked, what was found, and what has not been checked
- [mobile.md](./mobile.md) — the Expo app, how to build it, and what has never been verified on a device
- [sounds.md](./sounds.md) — which sound for which event, and why the client makes it
- [notifications.md](./notifications.md) — in-app, push and email; preferences, quiet hours, delivery records
- [api-keys.md](./api-keys.md) — keys and service tokens: credentials that are not sessions
- [developer-reference.md](./developer-reference.md) — `/developer`: the API as it describes itself
- [webhooks.md](./webhooks.md) — where a firm is told about its own events, and how it verifies them

**Operations**

- [worker.md](./worker.md) — scheduled jobs: swap accrual, reconciliation, sweeping
- [reconciliation.md](./reconciliation.md) — what is compared, what is never repaired
- [external-reconciliation.md](./external-reconciliation.md) — the platform's records against a venue's, and what is never repaired
- [reports.md](./reports.md) — a query, a sealed file and a download that expires
- [broker-panel.md](./broker-panel.md) — what the person running a firm can see and do, and what is still missing
- [feature-flags.md](./feature-flags.md) — what a deployment or a firm has switched on, and who may say
- [anti-fraud.md](./anti-fraud.md) — integrity signals: observations, never verdicts
- [database.md](./database.md) — schema conventions, the ledger, transactions, indexes
- [multi-tenancy.md](./multi-tenancy.md) — how one platform holds several firms, and where the boundary is enforced
- [brokers.md](./brokers.md) — the two kinds of tenant, role groups, who appoints whom, and how a broker is created
- [security-events.md](./security-events.md) — the security feed, derived from the audit log, for a person and for the firm
- [security-centre.md](./security-centre.md) — what a person can see about their own account's security
- [ip-rules.md](./ip-rules.md) — where the firm may be reached from, and why a rule that locks out its author is refused
- [break-glass.md](./break-glass.md) — staff seeing what one trader sees, temporarily, on the record
- [secrets.md](./secrets.md) — where a secret may come from and what happens to it after
- [broker-adapter-sdk.md](./broker-adapter-sdk.md) — the port a venue connector implements, its capabilities, the connection state machine and the contract suite
- [broker-integration.md](./broker-integration.md) — how a venue is connected, why none is yet, and how credentials are held
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
- [capacity.md](./capacity.md) — what the load harness found, and the run that has not been done
- [failure-injection.md](./failure-injection.md) — `pnpm chaos`: killing the dependencies and checking nothing is closed by it
- [final-audit.md](./final-audit.md) — the browser, concurrency and integration pass, and the margin race it found
- [backup-restore.md](./backup-restore.md) — the rehearsal, and why row counts are not the check
- [disaster-recovery.md](./disaster-recovery.md) — what is lost, how much, and how long until the platform is back
- [observability.md](./observability.md) — logs, metrics, health, what to alert on
- [operations.md](./operations.md) — the kill switch, and why closing is always allowed
- [deployment.md](./deployment.md) — local setup, images, probes, migrations, scaling
- [deployment-cpanel.md](./deployment-cpanel.md) — deploying behind cPanel on the kind of host this repository actually met
- [runbook.md](./runbook.md) — what to do when something is wrong, for whoever is on call
