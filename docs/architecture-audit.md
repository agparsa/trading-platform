# Architecture audit — the repository against the multi-broker specification

**Baseline:** `445a801` (cloud) / `f630e3e` (GitHub `main`, deployed at devopss.ir).
4 applications, 16 workspace packages, 49 Prisma models, 146 API routes, 134
test files / 1,787 tests, 18 API smoke checks, 8 WebSocket checks, 69 browser
checks across 24 routes, 42 pentest probes. All green. Live since 1 September.

**Specification:** the multi-tenant, multi-broker trading-platform prompt of
3 September 2026 (114 sections; screenshots of two commercial terminals as the
UX reference). This document is its §3, produced by inspecting the repository —
`ls`, `grep`, the schema, the tests — not by recalling it. The previous audit,
[ARCHITECTURE_AUDIT.md](./ARCHITECTURE_AUDIT.md), was written against the
earlier specification at a much earlier baseline and is kept as history.

The one-paragraph verdict: **the trading core the specification wants to
preserve exists and is good; what is missing is everything that begins with
the word "broker"** — the adapter SDK, external execution, connection state,
external mapping, external reconciliation — plus the terminal-UX upgrade the
screenshots describe, chart persistence, white-label, locale, a server-side
close-all, break-glass, and webhooks. Nothing in the core needs rewriting to
add any of it; every one has an extension point already named below.

---

## 1. Existing architecture

```
 apps/web (Next.js 15, React 19)   apps/mobile (Expo 57 / RN 0.86)
            |                                  |
            v                                  v
 apps/api (NestJS 11) — REST /api/v1 + Socket.IO /ws   ← one instance per role:
   api (serves), api-ingest (market feed + trigger engine), scaled by env flags
            |
            v
 packages/* domain (pure, framework-free, ESLint-enforced)
   financial-core · trading-core · risk-core · market-core · reconciliation-core
   integrity-core · payments-core · kyc-core · withdrawals-core · chart-core
   crypto-core · tenancy · push-core · shared-types · api-client · ui
            |
            v
 PostgreSQL 16 (Prisma 6, NUMERIC everywhere, RLS)   Redis 7 (pub/sub, BullMQ)
            ^
 apps/worker (NestJS, BullMQ): swap accrual, reconciliation, maintenance, notifications
```

The rule the whole repository follows — _the trading engine is the system, the
UI is a client_ — is the specification's §110 already: balance, equity, margin,
P&L, position and order state, SL/TP and permissions are computed on the
server, persisted, and pushed; the browser and the phone render what they are
told.

Execution today is **INTERNAL only** (§2): `MARKET_DATA_PROVIDER=internal-simulator`
feeds a deterministic simulator into the engine; `external` is declared and
refuses to boot rather than pretending. There is no external execution path.

## 2. Existing modules

| Area                                  | Where                                                                                                           | State                                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                        | `apps/api/src/auth`                                                                                             | argon2, JWT + rotating refresh (families, replay detection), 2FA + recovery codes, email verification, invitations, sessions, devices                         |
| Authorization                         | `common/guards`, `permissions/`, `packages/shared-types/permissions.ts`                                         | roles as rows per tenant, 55 capabilities, incompatibility pairs, escalation rule, reconciled at boot                                                         |
| Tenancy                               | `packages/tenancy`, `apps/api/src/tenancy`                                                                      | Prisma extension + PostgreSQL RLS with a non-owner role; hostname → tenant; cross-tenant tests and pentest probes                                             |
| Credentials                           | `apps/api/src/credentials`                                                                                      | API keys (person, subset of role) and service tokens (firm, read-only); hashed, shown once, per-credential rate limit, usage                                  |
| Trading                               | `apps/api/src/trading`, `packages/trading-core`                                                                 | orders (MARKET/LIMIT/STOP/STOP_LIMIT), positions, partial close, reverse, SL/TP, trailing stop, trigger engine, liquidation, one-click, previews              |
| Risk / margin                         | `packages/risk-core`, `apps/api/src/trading`                                                                    | composable pure `RiskRule`s, per-account limits, margin call / stop-out levels, kill switch, structured rejection codes                                       |
| P&L / ledger                          | `packages/financial-core`, `apps/api/src/accounts`                                                              | Decimal `Money`, append-only `BalanceLedger`, replay check, commission both legs, swap settled nightly                                                        |
| Market data                           | `packages/market-core`, `apps/api/src/market`                                                                   | `MarketDataProvider` port, simulator + scripted providers, tick bus over Redis, candles, sessions                                                             |
| Realtime                              | `apps/api/src/realtime`                                                                                         | Socket.IO gateway, scoped channels, sequence numbers, `DomainEvent` bus with `eventId`, exposure index, risk-state transitions                                |
| Wallet / payments / KYC / withdrawals | `wallet`, `payments`, `kyc`, `withdrawals`                                                                      | two ledgers, provider ports (adapters pending a commercial choice), sealed documents, FINANCE role                                                            |
| Master accounts                       | `apps/api/src/master`, `packages/shared-types` (`LINKABLE_CAPABILITIES`)                                        | desk → accounts links carrying per-account capabilities; no aggregation views; no master roles                                                                |
| Reconciliation                        | `packages/reconciliation-core`, `apps/worker`                                                                   | internal self-consistency (orders ↔ executions ↔ positions ↔ trades ↔ ledger), findings with resolution, hourly; no external side yet                         |
| Integrity / anti-abuse                | `packages/integrity-core`, `apps/api/src/integrity`                                                             | signals with evidence, operator review, never auto-punishing (`docs/anti-fraud.md`)                                                                           |
| Notifications                         | `apps/api/src/notifications`, `apps/worker/src/push`, `packages/push-core`                                      | in-app, web push, mobile push, email, sounds; preferences; dedupe by `eventId`                                                                                |
| Admin console                         | `apps/web/src/app/admin/*` (13 sections)                                                                        | overview, people, accounts, instruments, risk, payments, verification, withdrawals, reconciliation, roles, credentials, audit                                 |
| Terminal                              | `apps/web/src/components/terminal.tsx` and siblings                                                             | watchlist, chart (lightweight-charts) with draggable SL/TP/pending lines, order ticket, positions/pending/history panels, shortcuts, toasts, connection badge |
| Mobile                                | `apps/mobile` (Expo Router: trade, market, positions, orders, history, notifications, profile, settings, chart) | builds for Android; **never run on a device**; SecureStore for tokens; no biometric unlock                                                                    |
| Observability                         | `apps/api/src/metrics`, `docs/observability.md`, `capacity.md`                                                  | Prometheus metrics, health/ready split, structured pino logs, soak and load scripts                                                                           |
| Deployment                            | `docker/`, `docker-compose.prod.yml`, `scripts/*.sh`                                                            | api / api-ingest / worker / web / nginx / postgres / redis; first-deploy, upgrade (backup → migrate → build → restart), first-administrator                   |

## 3. Existing database

49 models, all money in `NUMERIC(28,10)` (69 columns, asserted by
`scripts/assert-no-float-columns.ts`), every tenant-owned table under RLS.
Against the specification's §6 minimum concept list:

| Specification concept                                       | Exists as                                                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform                                                    | implicit (the deployment); no row                                                                                                                               |
| Tenant / Broker                                             | `Tenant` — **a broker is a tenant**; nothing to add but naming                                                                                                  |
| BrokerConnection, BrokerCredential, BrokerUser              | **missing**                                                                                                                                                     |
| User, Session, Device                                       | `User`, `RefreshToken` (families = sessions), `Device`                                                                                                          |
| MasterAccount, AccountMembership                            | `MasterAccount`, `MasterAccountLink` (capabilities per account)                                                                                                 |
| TradingAccount                                              | `Account` (+ `AccountSettings`)                                                                                                                                 |
| Instrument, BrokerInstrumentMapping                         | `Symbol` + `SymbolSpec` (platform) + `TenantSymbolTerms` (broker overrides); external mapping **missing**                                                       |
| TradingSession, Candle                                      | `MarketSession`, `Candle`                                                                                                                                       |
| Quote, Tick                                                 | in Redis / memory only (by design: ticks are not persisted)                                                                                                     |
| Order, OrderExecution, Position, PositionEvent, Trade       | `Order` (+ `OrderEvent`), `Execution`, `Position`, `PositionEvent`, `Trade`                                                                                     |
| LedgerAccount, LedgerEntry, BalanceSnapshot, MarginSnapshot | `Account` + `BalanceLedger`; `AccountSnapshot` (balance, equity, margin)                                                                                        |
| Commission, Swap, CashMovement                              | ledger entry types; `WalletTransaction`                                                                                                                         |
| RiskProfile, MarginProfile, LeverageProfile, FeeProfile     | `RiskRuleConfig`, `AccountSettings` (limits, levels), `SymbolSpec` / `TenantSymbolTerms` (margin rate, commission, swap); **not first-class reusable profiles** |
| Notification, Alert                                         | `Notification` (+ preferences, push); price alerts **missing**                                                                                                  |
| APIKey                                                      | `ApiKey`, `ServiceToken`, `CredentialUsage`                                                                                                                     |
| Webhook                                                     | **missing**                                                                                                                                                     |
| ReconciliationRun, ReconciliationItem                       | `ReconciliationRun`, `ReconciliationFinding` (with resolution fields); external statuses **missing**                                                            |
| AuditLog, SecurityEvent, FraudSignal                        | `AuditLog` (append-only, triggers); `IntegritySignal` (+ events); `SecurityEvent` **missing**                                                                   |
| ChartLayout, ChartTemplate, UserDrawing                     | **missing** (chart state is client-local)                                                                                                                       |
| Subscription, TenantBranding                                | **missing**                                                                                                                                                     |

Order states: NEW, PENDING, ACCEPTED, TRIGGERED, PARTIALLY_FILLED, FILLED,
MODIFY_REQUESTED, CANCEL_REQUESTED, CANCELLED, REJECTED, EXPIRED. Position
states: OPEN, CLOSING, CLOSED (the claim lock makes `CLOSING` the concurrency
boundary; `OPENING`/`MODIFYING` do not exist and are not needed by the
internal engine — they become meaningful only with external execution).
Account states: ACTIVE, RESTRICTED, CLOSE_ONLY, SUSPENDED, CLOSED.

## 4. Existing realtime flow

```
MarketDataProvider (simulator | scripted | external: declared, absent)
  → TickBus (Redis `market:ticks`, sequence per instrument)
  → api-ingest: trigger engine (SL/TP/trailing/stops, liquidation) · valuations
  → DomainEvent bus (local handlers + Redis `domain:events`, eventId, origin, tenantId)
  → RealtimeGateway (Socket.IO): channels QUOTES / CANDLES / ACCOUNT / ORDERS / POSITIONS,
    scoped to the accounts the socket's user may see (ownership or master link),
    `seq` per socket, re-snapshot on reconnect
  → Notifications subscriber (dedupe by eventId) · exposure index · metrics
```

No `setInterval` polling drives trading; the guard that finds background work
running with no tenant (`background-scope.test.ts`, `outsideAnyScope`) is in
place after the two incidents that motivated it. Singleton work (ingest,
trigger engine) is partitioned by **configuration** — exactly one `api-ingest`
service has `MARKET_INGEST_ENABLED` / `TRIGGER_ENGINE_ENABLED` — not by leader
election. A second ingest instance started by mistake would double-run.

## 5. Existing trading flow

```
POST /orders (Idempotency-Key, DTO validation, permission, account access)
  → OrdersService: account lock (FOR UPDATE), status/permission/instrument/market/quote
    freshness/volume/margin/exposure/risk-rule checks with structured codes
  → internal execution at bid/ask, Execution + Position + PositionEvent + BalanceLedger
    in one transaction, margin reserved atomically
  → DomainEvent after commit → socket frames, notification, integrity signals
Resting orders / SL / TP / trailing: trigger engine on api-ingest, per tenant, claim-locked
Close / partial / reverse: PositionsService, version-guarded, `CLOSING` claim, one close wins
```

Concurrency is tested: ten simultaneous closes produce one trade; ten
simultaneous orders on one account never spend margin twice; SL versus manual
close leaves one transition. Quote staleness refuses execution (`STALE_QUOTE`).

## 6. Existing risks

1. **No external execution path.** Everything above ends at the internal
   engine. The specification's §41–43 and §67 (timeouts, UNKNOWN state, late
   fills, reconnect recovery) have no code because there is no broker to talk
   to. Building the adapter SDK, mock adapter and contract tests is possible
   now; a real connector is **BLOCKED** on a broker's API specification and
   credentials, and the specification says to stop there and report.
2. **Singletons by configuration, not election** (§64). Correct on one host;
   fragile the day a second ingest instance is started.
3. **Close-all is a client loop** (§25): the terminal confirms once and sends
   one close per position. Under load or a dropped connection that is a
   partial close-all with no record of the intent.
4. **The event envelope predates the specification's schema** (§93): it has
   `eventId`, `event`, `tenantId`, `accountId`, `data`, `timestamp`; it lacks
   `version`, `aggregateType`/`aggregateId`, `correlationId`, `causationId`,
   `actorId`. Consumers (sockets, notifications) depend on the current shape;
   the change is additive.
5. **No tenant-level, account-level or master-level rate limits** (§68) —
   per address, per login, per order path, per socket, per credential exist.
6. **Roles are per tenant only** (§8). There are no platform-level roles: the
   operator of the platform is an ADMIN of the default tenant. Master roles do
   not exist; master links carry capabilities instead. The specification's
   role names are a naming and grouping change over the existing
   capabilities-as-rows model, not a new mechanism.
7. **The terminal predates the UX reference** (§17–24, 52, 82): it has the
   parts — watchlist, chart with draggable levels, ticket, panels — but not the
   information architecture the screenshots show (account bar with equity and
   P&L, favourites / top movers / categories with spread and status, inline
   quick trade, bottom tabs with finance/alerts/logs, multi-select close, edit
   dialog with distance/ticks/P&L/% for SL and TP).
8. **Mobile has never run on a device**, has no biometric unlock, and its
   reconnect states are not surfaced as the specification lists them.
9. **Production has no administrator** — an operational fact, fixed by
   `scripts/first-administrator.sh`, waiting on a decision.

## 7. Existing reusable abstractions (the specification's §4, all present)

| Abstraction                                              | Where                                                                            | Keep as                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `MarketDataProvider`                                     | `packages/market-core/src/provider.ts`                                           | the only way prices enter; a broker feed implements it                          |
| `RiskRule`                                               | `packages/risk-core/src/rules/*`                                                 | pure `(order, context) → violation \| null`; new layers add rules, not branches |
| `DomainEvent` / envelope                                 | `packages/shared-types/src/events.ts`, `apps/api/src/realtime/events.service.ts` | the integration boundary; extend the envelope, never bypass it                  |
| `TradingCommandAdapter`                                  | `apps/web/src/lib/chart-commands.ts`                                             | every chart/UI action goes through it; mobile mirrors it                        |
| `buildChartDatafeed` / TradingView seam                  | `apps/web/src/lib/chart-datafeed.ts`, `tradingview-datafeed.ts`                  | renderer swap stays in `apps/web`                                               |
| `PaymentProvider`, `KycProvider`, `PayoutProvider` ports | `packages/*-core`                                                                | the pattern the broker adapter SDK follows                                      |
| `SecretBox`                                              | `packages/crypto-core`                                                           | envelope encryption for broker credentials                                      |
| Tenancy scope                                            | `packages/tenancy`                                                               | every broker-owned row already isolated                                         |
| Roles as rows                                            | `permissions/roles.service.ts`                                                   | platform / broker / master role groups are seeds, not code                      |

## 8. Proposed extension points

- **Broker = Tenant.** No new tenancy. `Tenant` gains a `kind` (PLATFORM | BROKER)
  and a `Broker` profile row; `BrokerConnection` (adapter kind, status, health,
  capabilities snapshot), `BrokerCredential` (sealed with `SecretBox`, metadata
  only outward), `BrokerInstrumentMapping` hang off it.
- **`@tp/broker-sdk`**: the `BrokerAdapter` interface with capability discovery,
  the connection state machine (CONNECTED / CONNECTING / DISCONNECTED /
  DEGRADED / AUTH_FAILED / RATE_LIMITED / UNKNOWN), a mock adapter, and a
  contract test suite every adapter must pass — the shape `payments-core` and
  `kyc-core` already use.
- **Execution mode on the account** (`INTERNAL` | `EXTERNAL_BROKER`), read by
  `OrdersService` at the one point it executes; the external branch hands the
  normalised order to the adapter and records external ids on `Order`,
  `Execution`, `Position` (`externalOrderId` etc.), with an `UNKNOWN` outcome
  state and a recovery query, never a blind retry.
- **Outbox / inbox**: an `OutboxEvent` table written in the same transaction
  as the domain change and relayed by the worker; a `BrokerInboundEvent` table
  keyed by external event id for dedupe, ordering and replay.
- **Event envelope v2**: additive fields; `version: 2`.
- **Role groups**: platform roles as a seed on the platform tenant; master
  roles as seeds whose capabilities are the existing `LINKABLE_CAPABILITIES`.
- **`CloseAllPositionsCommand`** in `PositionsService`, one lock, one audit row,
  one event per position.
- **Chart persistence**: `ChartLayout`, `ChartTemplate`, `UserDrawing` — the
  client keeps rendering; the server keeps the state.
- **`TenantBranding`** read by the web shell through design tokens (the
  `theme` the terminal already uses).
- **`SecurityEvent`** as a first-class feed beside `IntegritySignal`.
- **Webhooks**: `Webhook`, `WebhookDelivery`, delivery worker, signed payloads,
  retry schedule, replay — subscribing to the existing bus.

## 9. Files that will be modified

`prisma/schema.prisma` (additive), `packages/shared-types/src/{permissions,events,enums}`,
`packages/tenancy/src/scope.ts`, `apps/api/src/trading/orders.service.ts` (one
execution branch), `positions.service.ts` (close-all), `realtime/events.service.ts`
(envelope v2), `realtime/realtime.gateway.ts` (routing additions only),
`admin/*` (broker panel routes), `apps/web/src/components/{terminal,watchlist,order-ticket,positions-panel,chart-panel,account-header}.tsx`
and their `lib/` companions, `apps/mobile/src/app/*`, `docker-compose.prod.yml`
(service split), `scripts/upgrade-server.sh` (unchanged unless a service is added).

## 10. Files that should not be rewritten

`packages/financial-core`, `packages/trading-core`, `packages/risk-core`
(pure, proven, 1,000+ tests between them); `apps/api/src/trading/orders.service.ts`
and `positions.service.ts` beyond the two seams named above; `packages/tenancy`
and the RLS migrations; `apps/api/src/realtime/realtime.gateway.ts`'s
authorisation and sequencing; `apps/api/src/accounts/ledger.service.ts`;
`apps/api/src/common/guards/*`; `scripts/upgrade-server.sh`'s ordering;
`docs/pnl.md`'s definitions (`marginLevel` versus `marginUtilization` — §37
says do not invert them, and they are not).

## 11. Gap matrix

PASS: present and tested. PARTIAL: present, short of the section. MISSING:
absent. BLOCKED: cannot be finished without something outside the repository.

| §                 | Area                                            | Status  | Note                                                                                                                                                            |
| ----------------- | ----------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2                 | Execution modes                                 | PARTIAL | INTERNAL complete; EXTERNAL_BROKER absent                                                                                                                       |
| 4                 | Non-negotiable abstractions                     | PASS    | all four present                                                                                                                                                |
| 5                 | Money / precision                               | PASS    | Decimal, NUMERIC, strings; rules in `docs/pnl.md`, `margin.md`                                                                                                  |
| 6                 | Domain model                                    | PARTIAL | see §3 table                                                                                                                                                    |
| 7                 | Multi-tenancy                                   | PASS    | RLS + extension + tests + probes                                                                                                                                |
| 8                 | Role model                                      | PARTIAL | granular capabilities as rows; platform/master role groups missing                                                                                              |
| 9                 | Break-glass / impersonation                     | MISSING |                                                                                                                                                                 |
| 10–11             | Broker adapter SDK, account mapping             | MISSING | buildable now; real connector BLOCKED on a broker API                                                                                                           |
| 12                | Credential security                             | PARTIAL | `SecretBox`, sealed documents/destinations; broker credentials do not exist yet                                                                                 |
| 13–14             | Broker panel, dashboard                         | PARTIAL | 13 admin sections; missing masters, cross-tenant orders/positions/trades, connections, sessions/devices/IP rules, branding, reports, developer docs, live cards |
| 15                | Master accounts                                 | PARTIAL | links + capabilities; no aggregation, no master roles, no desk risk layer                                                                                       |
| 16                | Multi-account user                              | PASS    | account selector; state scoped per account                                                                                                                      |
| 17–24             | Terminal IA, header, watchlist, tickets, panels | PARTIAL | parts exist; the reference's architecture does not                                                                                                              |
| 25                | Server-side close-all                           | MISSING | client loop today                                                                                                                                               |
| 26–27             | Chart, drawing persistence                      | PARTIAL | candles/volume/timeframes/overlays; indicators and drawings not persisted                                                                                       |
| 28–29             | Overlays, draggable SL/TP                       | PASS    | preview → confirm → server → refetch; tested                                                                                                                    |
| 30–31             | Edit dialog, shared calculator                  | PARTIAL | modify exists; distance/ticks/P&L/%/RR calculator not shared                                                                                                    |
| 32–35             | Market data, realtime, freshness                | PASS    | measurements in `capacity.md`; latency metrics partial (§34)                                                                                                    |
| 36                | Market status states                            | PARTIAL | OPEN/CLOSED/halt; PRE_OPEN/POST_CLOSE/UNKNOWN absent                                                                                                            |
| 37–39             | P&L, fees, risk engine                          | PASS    |                                                                                                                                                                 |
| 40                | Risk hierarchy                                  | PARTIAL | platform → broker → account; no master/desk layer                                                                                                               |
| 41–43             | External execution, outbox, disconnect          | MISSING | see §6                                                                                                                                                          |
| 44                | Reconciliation                                  | PARTIAL | internal only; external statuses and `ResolutionRecord` missing                                                                                                 |
| 45                | Ledger                                          | PASS    |                                                                                                                                                                 |
| 46                | Anti-fraud                                      | PARTIAL | signals + review exist; `SecurityEvent`, rate/replay/device signals partial                                                                                     |
| 47                | Security                                        | PASS    | see `SECURITY_AUDIT.md`, `penetration-checklist.md`                                                                                                             |
| 48                | API keys                                        | PASS    | scopes are capabilities                                                                                                                                         |
| 49                | Webhooks                                        | MISSING | designed; not built                                                                                                                                             |
| 50–51             | Notifications, sounds                           | PASS    |                                                                                                                                                                 |
| 52, 57, 61, 83–86 | Terminal UX, responsive, a11y, quality          | PARTIAL | see Phase 6                                                                                                                                                     |
| 53–56             | Mobile                                          | PARTIAL | app exists; never run on a device; biometric, reconnect states missing                                                                                          |
| 58                | Chart library seams                             | PASS    |                                                                                                                                                                 |
| 59                | White label                                     | MISSING |                                                                                                                                                                 |
| 60                | Locale (English + Persian, RTL)                 | MISSING |                                                                                                                                                                 |
| 62                | Audit log                                       | PASS    |                                                                                                                                                                 |
| 63                | Observability                                   | PARTIAL | metrics exist; several named metrics absent                                                                                                                     |
| 64                | Distributed leadership                          | PARTIAL | configuration partitioning; no lock                                                                                                                             |
| 65–66             | Database, concurrency                           | PASS    |                                                                                                                                                                 |
| 67                | Failure handling                                | PARTIAL | internal paths; external paths do not exist                                                                                                                     |
| 68                | Rate limiting                                   | PARTIAL | no tenant/account/master limits                                                                                                                                 |
| 69–71             | API design, envelope, idempotency               | PASS    |                                                                                                                                                                 |
| 72–75             | Security tests, load, failure injection         | PARTIAL | pentest + load + soak; failure injection partial                                                                                                                |
| 76                | Disaster recovery                               | PARTIAL | backup/restore + rehearsal; `disaster-recovery.md` to write                                                                                                     |
| 77–79             | Deployment, config, migrations                  | PASS    | service split for ws/ingest/trigger is by env, not by container yet                                                                                             |
| 80–81             | UI state, optimistic UI                         | PASS    |                                                                                                                                                                 |
| 87–90             | Account/broker status, instruments              | PARTIAL | account states fine; broker status absent                                                                                                                       |
| 91, 113           | PropFA seam                                     | PASS    | none of it in the repository                                                                                                                                    |
| 92–94             | Analytics/event schema, versioning              | PARTIAL | envelope v2 needed                                                                                                                                              |
| 95                | Feature flags                                   | PARTIAL | env flags per feature; no flag service                                                                                                                          |
| 96                | Documentation                                   | PARTIAL | 60 documents; names to add: broker-integration, broker-adapter-sdk, uiux, disaster-recovery                                                                     |
| 100–103           | Acceptance scenarios                            | PARTIAL | internal path passes end to end today; broker steps need Phases 2–3                                                                                             |
| 105               | Mobile acceptance                               | BLOCKED | needs a device, and iOS needs macOS + Xcode + a signing key                                                                                                     |

The sequence that closes these gaps is [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
