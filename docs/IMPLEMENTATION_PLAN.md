# Implementation Plan

**Baseline:** `f630e3e` on `main`, deployed at devopss.ir. 134 test files /
1,787 tests, 18 API smoke checks, 8 WebSocket checks, 69 browser checks, 42
pentest probes — all green.

**Target:** the multi-tenant, multi-broker trading-platform specification of
3 September 2026, with the two commercial terminals in its screenshots as the
UX reference. Sixteen phases, numbered as the specification numbers them.

**Audit:** [architecture-audit.md](./architecture-audit.md) — what exists,
what is short, what is absent, and the extension point for each.

---

## Read this first

This is the second plan this repository has carried. The first — sixteen phases
against the standalone-platform specification — is complete through its
phase 9 and is recorded at the end of this document; its work is the baseline
above, and nothing in it is undone.

The distance from the baseline to the new target is **months, not weeks**, and
most of it is one word: _broker_. The trading core the specification insists
on preserving exists and is proven. What does not exist is external
execution — the adapter SDK, connection state, external mapping, external
reconciliation — and the terminal the screenshots describe. This plan builds
the first with mock adapters and contract tests up to the point where a real
broker's API specification is needed, and stops there and says so, because the
specification says to. It builds the second on the terminal that exists.

## The ordering principle

1. **Foundations that other phases read go first.** Broker as a first-class
   tenant profile, the role groups, the event envelope's second version — every
   later phase writes against them.
2. **Nothing external is faked.** Phase 2 ships an adapter interface, a state
   machine, a mock and a contract suite; a connector to a real venue is a
   separate, later act that starts with reading that venue's documentation.
3. **The terminal is upgraded, not replaced.** The chart's draggable levels,
   the ticket's checks, the panels' commands all stay; the information
   architecture around them changes.

## Definition of Done

From §99, applied per phase: domain model, API, authorization, tenant
isolation, validation, persistence, realtime events where required, UI on real
state with error/loading/empty states, security tests, regression tests,
documentation, observability where relevant. Plus this repository's own rules:
no float near money; every mutation audited with before and after; tenant from
the authenticated context only; no secret stored raw, logged or committed;
`pnpm verify` **and** `pnpm smoke` green, because one does not boot the
application and the other does; and the production log read after every
deploy, because three real defects this month were invisible to 1,700 tests.

---

## Phase 0 — Repository audit · **done**

[architecture-audit.md](./architecture-audit.md). Produced by inspection.

## Phase 1 — Domain and multi-tenant foundation · **done**

Most of the foundation exists (tenancy with RLS, roles as rows, capabilities,
audit). What this phase adds is the vocabulary the rest of the specification
uses, additively:

- `Tenant.kind` (PLATFORM | BROKER) and a `Broker` profile (legal name,
  status, default execution mode, limits). The default tenant is the platform.
- **Role groups.** Platform roles (`PLATFORM_SUPER_ADMIN`, `PLATFORM_OPERATOR`,
  `PLATFORM_SUPPORT`, `PLATFORM_AUDITOR`, `PLATFORM_DEVELOPER`) seeded on the
  platform tenant; broker roles (`BROKER_OWNER`, `BROKER_ADMIN`,
  `BROKER_TRADING_MANAGER`, `BROKER_SUPPORT`, `BROKER_ANALYST`,
  `BROKER_DEVELOPER`) as the broker tenant's built-ins, mapped onto the existing
  capabilities; `TRADING_USER` = `USER`. The existing roles keep working; the
  reconcile-at-boot mechanism seeds the new ones.
- **Event envelope v2**: `version`, `aggregateType`, `aggregateId`, `actorId`,
  `correlationId` (the request id), `causationId` — additive, consumers
  untouched, `docs/realtime.md` updated.
- `SecurityEvent` model and service (login, 2FA, session revoked, credential
  minted/revoked, suspicious sign-in) — the feed §46 and §62 want, written
  from the places those things already happen.
- Account status `LOCKED` and `PENDING` with explicit trading behaviour.
- Tenant-level and account-level rate limits (§68) in the existing throttling.

Tests: role-group seeds, envelope v2 shape, security events written, cross-tenant
probes extended to the new tables.

Done as written, plus what the work found: the assignability rule (who may put
whom into which role — group, then edited-grants), role-granting invitations,
the broker creation flow with the owner invitation, and one policy table for
what every account status allows. [brokers.md](./brokers.md),
[security-events.md](./security-events.md), and the Phase 1 section of
[COMPLETION_STATUS.md](./COMPLETION_STATUS.md).

## Phase 2 — Broker connection and adapter SDK · **done, except the connector**

`packages/broker-sdk`:

- `BrokerAdapter` interface with the §10 method set and **capability
  discovery** (`getCapabilities()` → supportsMarketOrders … supportsApiToken).
- Connection state machine: CONNECTED, CONNECTING, DISCONNECTED, DEGRADED,
  AUTH_FAILED, RATE_LIMITED, UNKNOWN; heartbeat, last quote, last order event,
  backoff, circuit breaker (§43, §88).
- `MockBrokerAdapter` with scripted behaviours: fills, partial fills,
  rejections, timeouts, disconnects, duplicate and out-of-order events — the
  failure catalogue of §41 and §67 as fixtures.
- A **contract test suite** any adapter must pass.
- `BrokerConnection`, `BrokerCredential` (sealed with `SecretBox`; metadata
  only leaves the server), admin routes and a Connections / Credentials /
  Connection Health section in the broker panel.

**BLOCKED after this point:** a connector to a real venue needs that venue's
API documentation and sandbox credentials. The interface, mock, contract
tests, credential abstraction, state machine and mapping layer will be ready;
the connector is reported as blocked, not stubbed.

Done as written. `@tp/broker-sdk` (port, capabilities, `ConnectionMonitor`,
`MockBrokerAdapter` with the whole failure catalogue, `brokerAdapterContract`,
credential envelope, registry that refuses an undocumented connector);
`BrokerConnection` and `BrokerCredential` with RLS and immutability triggers;
`/admin/broker-connections` and the Connections screen; the worker's
per-minute health sweep. The connector to a venue remains blocked on that
venue's documentation. [broker-adapter-sdk.md](./broker-adapter-sdk.md),
[broker-integration.md](./broker-integration.md).

## Phase 3 — Broker accounts and external account mapping · **done**

- `externalAccountId` on `Account`; `externalOrderId` / `externalExecutionId`
  / `externalPositionId` on the trading rows; `BrokerInstrumentMapping`.
- `Account.executionMode` (INTERNAL | EXTERNAL_BROKER). `OrdersService` gains
  one branch at the point it executes: external orders go to the adapter with
  a client order id, and their outcome is FILLED / REJECTED / **UNKNOWN**; an
  UNKNOWN outcome is recorded, queried back, and never retried blindly (§41,
  §103).
- Outbox (`OutboxEvent`, written with the domain change, relayed by the
  worker) and inbox (`BrokerInboundEvent`, keyed by external id: dedupe, order,
  replay) (§42).
- Reconnect recovery sequence (§43) against the mock.

Done as written. `Account.executionMode` with a database CHECK that an
external account carries a connection and an identity at the venue;
`clientOrderId` / `externalOrderId` / `externalExecutionId` /
`externalPositionId` on the trading rows; `BrokerInstrumentMapping` (explicit,
audited, never inferred — an unmapped instrument is refused by name);
`OrderStatus.UNCONFIRMED` and `ExternalExecutionService`, the one branch in
the order path, which records the order row **before** the request leaves and
never resends; `VenueRecoveryService`, the sweep that asks venues what became
of orders whose answers were lost; `OutboxEvent` written inside the
transaction that produced the change and relayed by the worker with a backoff
held in the row; `BrokerInboundEvent`, unique on `(connection, external id)`,
immutable, ordered by the venue's own sequence, replayable. Instruments,
Inbox and "waiting on a venue" in the admin panel.
[external-execution.md](./external-execution.md).

## Phase 4 — Master accounts and permission hierarchy · **done**

- Master roles (`MASTER_OWNER`, `MASTER_MANAGER`, `MASTER_TRADER`,
  `MASTER_VIEWER`) as seeds over the existing `LINKABLE_CAPABILITIES`.
- Aggregation: exposure, P&L, margin, open positions and orders across a
  desk's accounts (§15).
- The desk layer in the risk hierarchy (§40): platform → broker → desk →
  account, each only stricter.
- Master Accounts section in the broker panel; desk view in the terminal.

Done, with one deliberate difference. The four master roles are **presets**
rather than roles: they expand at grant time into the capabilities stored on
the link, because widening `MASTER_TRADER` next quarter must not widen a
delegation somebody approved last year. `MASTER_OWNER` and `MASTER_MANAGER`
currently coincide — the linkable ceiling is exactly the manager set — and that
is stated in code and asserted by a test rather than papered over.

`DeskViewService` aggregates equity, balance, margin, open positions and net
exposure by symbol across a desk's accounts, converted into the desk's
currency, naming any account it could not price instead of adding it at par.
`RiskLimitSet` gives the hierarchy platform → broker → desk → account: each may
tighten what is above and none may loosen it, checked when a limit is written
(so a person is told which layer refused them) and again when it is read (so a
row that arrived another way cannot widen anything). The desk layer binds the
**route** — an order placed through that desk — not the account, and
`Order.placedByMasterAccountId` carries it so a resting order fills under the
ceiling that governed its placement. Desks screen in the admin console; a
Ceilings tab on the Risk console.
[desks-and-risk-hierarchy.md](./desks-and-risk-hierarchy.md).

The desk view in the _terminal_ is not built: it belongs with the Phase 6
terminal work rather than beside an admin panel, and building it twice would be
worse than building it once in its right place.

## Phase 5 — Broker management panel · **partly done**

The §13 navigation on the existing admin console: dashboard cards from real
figures (§14), Users, Trading Accounts, Master Accounts, Orders / Positions /
Closed Trades / Order History across the tenant, Instruments and Sessions,
Risk / Margin / Leverage / Exposure, Fees, Broker Connections, Reconciliation,
Reports, Alerts, Audit, Security (Sessions, Devices, IP rules), Branding,
Developer (API keys — exists; Webhooks — Phase 12; API documentation). Every
table on a real query; every action on a real command.

Three gaps closed, and the rest named rather than stubbed.

**The firm's book** (`/admin/book`): orders, positions and closed trades across
the tenant, with an order's own event history — the answer to "why was that
rejected". Guarded by `accounts.read_any`, not `orders.read`, which every
trader holds. Keyset paging with the row id in the cursor, because orders share
milliseconds and offset paging over a moving book drops rows.

**The trading week**: `MarketSession` had no writer but the seed. It is edited
on the Instruments screen now — replaced whole, overlaps refused rather than
merged, timezone checked against the system's own database, platform-only, and
the engine's cached copy refreshed on save.

**Money on the dashboard**: balance held, deposits and withdrawals, commission
and swap earned, traders' net P&L, closed trades and volume — **by currency,
never summed across them**.

**Not built, and stated as such:** Fees as a section (commission and swap are
edited per instrument; there is no schedule, override or rebate model, and
spread comes from the feed); Reports (no server-side export — a job queue, a
file store and a retention policy, which is a phase of its own); Alerts (price
alerts are Phase 8; admin threshold rules are not designed); admin device
management and IP rules (no allow/deny concept exists anywhere — it belongs
with Phase 10, and carries real lock-out risk); Branding (the `Tenant` model
has no visual field; Phase 14 flags a feature nobody has written); Webhooks
(Phase 12); and API documentation, which is mounted only outside production.
[broker-panel.md](./broker-panel.md).

## Phase 6 — Trading terminal UX upgrade · **partly done**

The screenshots, as behaviour, on an original brand:

- **Header:** brand, environment badge, current broker, account selector with
  balance / equity / floating P&L, connection status, notifications, profile.
- **Watchlist:** Favourites, Top Movers, search, categories (forex, metals,
  indices, energy, crypto, equities); each row icon, symbol, price, daily %,
  spread, market status; the selected row expands to an inline quick ticket —
  SELL price / volume with − + and notional / BUY price — and an "Advanced
  order" link.
- **Advanced ticket:** market / limit / stop / stop-limit by capability;
  side, volume, entry, SL, TP, trailing, expiry, time in force; live margin,
  potential loss/profit, risk %, reward %, R/R, commission, estimated swap.
- **Bottom panel:** Open positions (n) · Pending · Closed · Order history ·
  Finance · Alerts · Logs; the §24 columns; multi-select with "Close (n)";
  filter and export.
- **Server-side `CloseAllPositionsCommand`** (§25).
- **Edit position dialog** (§30) with the **shared calculator** (§31) in
  `@tp/trading-core`: price / distance / ticks / P&L / % for SL and TP, R/R,
  used by the ticket, the dialog, chart drag and mobile.
- Toasts on confirmed events only; connection status; account switching that
  swaps every scoped store atomically (§16); quick-trading on/off and
  large-order confirmation (§86); design tokens (§52, §83); responsive
  compositions for tablet and mobile browser (§57); keyboard and screen-reader
  paths (§61); `docs/uiux.md`.

Four defects fixed; the presentation deferred, and named.

**One calculator, shared** (§31): `@tp/trading-core/levels.ts` — distance in
price and points, price at a distance, outcome, reward:risk, percent of equity,
and sizing from a risk. The arithmetic lived in three places in the web app and
a fourth on the phone, free to disagree; the disagreement was only ever visible
to the person who dragged a stop on the chart and read a different number in
the ticket. Direction is derived rather than asked for, no rate is ever
assumed, and sizing rounds **down**.

**`POST /positions/close-all`** (§25): the intent stated once, the outcome
reported per position. Deliberately not atomic — one unpriceable instrument
must not roll back closes that already happened at real prices — and the result
says so instead of a boolean that would have to lie. Largest margin first, so a
near-stop-out account releases the most margin soonest.

**Risk as a share of equity** in the ticket, and **large-order confirmation**
(§86) measured against the account rather than a lot count, forced even in
one-click mode. **An account selector**: the terminal used `accounts[0]` and
never exposed a way to change it, so a trader with two accounts could reach
only the first.

**Not delivered:** the inline quick ticket, categories and top movers;
stop-limit (an engine change, not a form control); trailing and expiry at
entry; estimated swap; Finance/Alerts/Logs tabs; multi-select "Close (n)"; the
edit dialog's other entry modes; spacing and typography scales; a light theme;
a documented accessibility pass. [uiux.md](./uiux.md) says why for each. The
parts built are the ones where the alternative was a defect; the rest is
presentation, and presentation without the screenshots it is meant to match
would be invention.

## Phase 7 — Chart, overlays, SL/TP drag · **persistence done, the rest BLOCKED**

The draggable levels exist; this phase adds indicators, the drawing set
(cursor, crosshair, horizontal/vertical, trendline, ray, rectangle, text,
measurement), the full timeframe list, bid/ask axis labels, P&L on the level
labels, and **persistence**: `ChartLayout`, `ChartTemplate`, `UserDrawing`,
indicator settings, viewport state — per user, per account.

**Persistence is built.** `ChartLayout`, `ChartTemplate` and `UserDrawing`,
per user and per account, with RLS and a partial unique index that allows one
default per person per account — "which chart do I get" must not depend on row
order. The arrangement is a blob this platform **never parses**: it is the
renderer's own description of itself, this platform is going to change
renderer, and holding an opinion about a format we do not own means being wrong
the first time it moves. Columns carry only what can be answered without
parsing — whose, which instrument, which resolution, which to open — which is
also the part that survives the swap. Size is capped at 256 KB with a refusal
that names both numbers. Drawings are keyed by instrument rather than by
layout, because a trendline drawn on gold is about gold and a layout switch
must not lose it. The web app persists and restores the instrument and
resolution, debounced, armed only after the restore.

**Indicators, the drawing set, bid/ask axis labels: BLOCKED** on the TradingView
Advanced Charts licence, which is what they are for. Building them on
`lightweight-charts` primitives would be writing a second charting library and
throwing it away when the licence arrives. P&L on the SL/TP level labels
already shipped in the existing drag work. The timeframe list is 6 of the 7
resolutions the server knows; `30` is orphaned in `market-core` and off by
default in `CANDLE_RESOLUTIONS`.
[charting.md](./charting.md).

## Phase 8 — Realtime and notification hardening · **done**

- **Envelope v2** was already on the wire (`DomainEventEnvelope`), added
  additively in an earlier phase. Nothing to do.
- **Leadership.** A lease in `leader_leases`, decided by the _database's_ clock,
  for the trigger engine, market ingest and price alerts.
  `TRIGGER_ENGINE_ENABLED` now means "this instance may contend" rather than
  "this instance runs it", and the market feed relays from its first second and
  switches to ingesting when it wins — so a rolling deploy never leaves the feed
  unattended. What a lease _cannot_ do is stated in the service rather than
  glossed over. [observability.md](./observability.md).
- Scheduled work in the worker needed no lock: BullMQ's job scheduler already
  produces one job per cron tick however many replicas are running. Checked
  rather than assumed, and left alone.
- **Latency (§34).** `tp_tick_to_pnl_seconds`, `tp_tick_to_socket_seconds`,
  `tp_quote_age_seconds`, `tp_order_ack_seconds`,
  `tp_realtime_pass_lag_seconds`, `tp_lease_wait_seconds` — every one measured
  from the tick's own timestamp, and tick-to-P&L against the _oldest_ unanswered
  tick, because a backlog makes the newest one younger.
- **Order timeline (§50).** `tp_order_stage_seconds` over received → validated →
  priced → executed, refusals included, plus a per-order log line. Client clock
  skew is recorded from an optional header, bounded, and never used to decide
  anything.
- **Price alerts.** Table, evaluation loop under its own lease, API, a terminal
  tab, a notification category and a sound. [price-alerts.md](./price-alerts.md).
- **Haptics.** `HAPTIC_FOR_CATEGORY` and a decision layer beside the sound one,
  decided on the same inputs and never derived from it — a trader with sound off
  still wants to feel a fill.

**Not done, and why:** queue lag has no Prometheus surface. It is recorded — the
worker logs `lagMs` on every completed job — but the worker serves no HTTP and
has nothing to scrape. Giving it an endpoint is a port, an Nginx route and a
scrape target, and belongs with that deployment change rather than being
half-done here.

## Phase 9 — Reconciliation · **partly done**

Against the mock adapter, which is the half that does not need a venue.

- **The comparison** (`@tp/reconciliation-core/external.ts`): balances, equity,
  orders, executions, positions and commission, producing every §44 status. An
  `UNKNOWN` is deliberately not a `MATCHED` — an item nobody could compare is
  not an item that agrees, and calling it one is how a report comes back clean
  on the day the venue starts returning empty fields.
- **`ReconciliationItem`** beside the existing findings, per run rather than
  deduplicated: a finding is the standing view of a problem, an item is one
  comparison at one moment. Only disagreements are rows; the run carries the
  counts.
- **`ResolutionRecord`** for every decision, append-only in the database rather
  than by convention, with a required reason. There is no `REPAIRED` decision
  because nothing here repairs anything (§112).
- **The rule the component exists for:** an unreachable venue concludes nothing.
  A failure to reach it aborts that account's comparison and is counted as
  unreachable; it never becomes a `MISSING_EXTERNAL`. §26 applied to the other
  end of the system.
- On-demand runs, synchronous so the caller learns whether the venue answered.

[external-reconciliation.md](./external-reconciliation.md).

**Not done, and why:** no _scheduled_ external run — which connections to sweep
and how often is a decision that belongs with the first real venue rather than
being guessed against a mock. Order and position _status_ are not compared
either: mapping a venue's status vocabulary onto this platform's is
provider-specific, and a mapping invented against the mock fails the moment a
real venue arrives. Swaps and cash movements are not compared because the
adapter interface exposes neither, and inventing the calls would be fabricating
an API. All three wait on **a broker's API documentation and sandbox
credentials**.

## Phase 10 — Security and anti-abuse · **done**

**Break-glass (§9) — done.** A grant, not a minted token: the staff member stays
themselves, so the audit trail always names who actually did it and revocation
is an `UPDATE` rather than chasing an issued token. Read-only enforced in the
guard by refusing every non-GET request that carries a grant — one check, rather
than a hope about which routes were remembered. Never across tenants, never
upward, never on yourself, never without a reason the database also checks.
Capped at `BREAK_GLASS_MAX_TTL_MS`, and the subject is told in their own
security feed. Reviewed under `system.operations`, deliberately not under the
permission that performs it. [break-glass.md](./break-glass.md).

`READ_WRITE` is in the enum and refused: a support person trading as a customer
needs controls a firm has to decide on, and inventing them would be inventing a
policy nobody agreed to.

**Rapid cancel/replace (§46) — done.** Counted per order over a lookback six
times the window, so a burst spread thinly across the period is not read as one.

**IP rules per tenant (§46) — done.** A firm says where its staff, and
optionally its customers, may reach it from. Almost all of the design is one
failure: an allow-list that excludes its own author locks the firm out of the
screen where the mistake could be undone. So a rule that would shut out its
author is refused — against the set as it _would be_, since an `ALLOW` covering
you is still a lock-out when a `DENY` covers you too — while disabling and
deleting are never refused, and the guard fails open, loudly, whenever it cannot
establish the caller's address. `TRUSTED_PROXY_HOPS` distinguishes _unset_
(nobody has said; nothing is enforced) from `0` (a claim that nothing sits in
front of the API), because collapsing the two either refuses every direct
deployment the feature or enforces an allow-list against an nginx container.
Enforced in a global guard after authentication and before authorization, so a
refused address never learns whether it would otherwise have been allowed in.
[ip-rules.md](./ip-rules.md).

**The Security Centre — done.** Two-factor, sessions, API keys and the
security feed already existed; what was missing was that every address in them
was the nginx container's. The request middleware now resolves the caller once
under `TRUSTED_PROXY_HOPS`, everything records `clientAddress(request)`, and a
lint rule refuses `request.ip` anywhere else. Added "where I have signed in
from": one row per address with first and last seen, what signed in from it and
whether a session there is still open — sign-ins counted as rotation families,
not token rows. A separate device registry and a raw own-audit view are
deliberately absent, with reasons. [security-centre.md](./security-centre.md).

**The remaining §46 signals — accounted for, not built.** Request rate is the
rate limiter (now per caller) and `ORDER_BURST`; duplicate ids are
`DUPLICATE_ORDER_ATTEMPTS`; replay is what idempotency keys absorb, and a signal
on a body-mismatch conflict would fire on client bugs. Reasons in
[anti-fraud.md](./anti-fraud.md).

**The §72 security test list — brought up to date.** The penetration checklist
now enumerates all 59 attacks the script runs, grouped by what the attacker is
trying to be; it said 42. [penetration-checklist.md](./penetration-checklist.md).

Phase 10 is **complete** for what this environment can verify.

## Phase 11 — Mobile architecture · ~3 weeks · partly BLOCKED

The Expo app exists. This phase: account switching that swaps state
atomically, chart with position overlays, SL/TP editing through the shared
calculator, reconnect with backoff/jitter/sequence recovery and the §55
states, biometric unlock (Keychain / Keystore), haptics, confirmations (§56).
**BLOCKED for acceptance (§105)** on a physical device; iOS additionally on
macOS, Xcode and a signing key — none of which this environment has.

## Phase 12 — Broker API, webhooks, developer portal · **done** (two items wait on producers)

**Webhooks (§49) — done.** `WebhookEndpoint` and `WebhookDelivery`; payloads
signed `t=…,v1=hmac-sha256` over the timestamp and the raw bytes, so a captured
delivery cannot be replayed and a receiver verifies the body it was sent
rather than the one it re-serialised; rotation signs with both secrets for a
day. Delivery is two steps — the outbox relay records what is owed, a job pays
it — so one receiver being down never holds up another firm's relay. The claim
is a lease (`FOR UPDATE SKIP LOCKED`, next attempt pushed out, attempt counted),
retries widen to six hours over eight attempts, an exhausted delivery is kept,
and an endpoint that exhausts deliveries in a row is switched off with a reason
and an audit row. The destination is checked when registered and again at
delivery against every address the name then resolves to, with the socket
pinned to the one that passed — DNS rebinding defeated, redirects never
followed. `/admin/webhooks` with the secret shown once. Person-only
`webhooks.manage`. [webhooks.md](./webhooks.md).

**The developer reference — done.** `/developer` renders the OpenAPI document
the API builds at boot and the conventions (signature header, credential
prefixes, keyable capabilities) from the constants that enforce them — fetched,
never typed, so it cannot drift. Behind a session; Swagger's own UI, which
mounts outside the guards, stays out of production and a test pins the `if`.
[developer-reference.md](./developer-reference.md).

**Still to do:** `reconciliation.mismatch` and `security.alert` once their
producers write outbox rows; service-token writes once the audit model has a
service actor.

## Phase 13 — Observability, load, failure injection · **in progress**

**Failure injection (§75) — done.** `pnpm chaos`: Postgres and Redis behind a
TCP proxy that adds latency, severs every connection or refuses; the API in two
instances, `SIGKILL`ed mid-burst; and one invariant checked after each — the
ledger sums to the balance, every accepted order filled exactly once, every
fill has an idempotency record. **It found a defect on its first properly timed
run:** 39 of 40 fills had committed with claims still `IN_PROGRESS`, so every
retry was refused for a day and the only path left doubled the fill. The claim
is now marked `COMMITTED` inside the operation's transaction, a retry gets
`IDEMPOTENCY_RESULT_UNAVAILABLE`, and a claim a crash left before commit is
taken over after a window instead of blocking. Also reported: ingest stalls on
a slow database (safe — `STALE_QUOTE`), and ~45 database messages per order.
[failure-injection.md](./failure-injection.md).

**Load at five hundred traders (§74) — done, and it paid for itself.** The
harness at 500 traders / 1,000 sockets / 2,000 simultaneous orders found four
defects in sequence, each fixed and pinned: boot opened a connection pool per
tenant (role reconciliation now runs through the privileged pool; the API
reports its connection budget at boot); quote fan-out sent a frame per tick
per socket (~20,000 serialisations/s at 200 sockets — quotes are conflated into
one `quotes.updated` frame per 100 ms); Node's 5 s keep-alive reset clients
that paused exactly that long (`HTTP_KEEP_ALIVE_TIMEOUT_MS`, 65 s); and the
burst overflowed the 511-entry listen backlog so 120 orders were refused with
`ECONNRESET` and no code (`HTTP_LISTEN_BACKLOG` 4,096 and admission control
`HTTP_MAX_IN_FLIGHT` 512 — above it a coded 503 with `Retry-After`, liveness
exempt). The run then passed with every refusal safe. Numbers, and the caveat
that the generator shares the two cores, in [capacity.md](./capacity.md).

**Still to do:** the 1,000-trader / 5,000-socket scenario on a host that is
not also running the generator; Grafana dashboards for the §63 metric set.

## Phase 14 — Production deployment hardening · **in progress**

**Feature flags (§95) — done.** A catalogue with two authorities — the platform
sets a broker's (`external_execution`, `webhooks`, `new_chart`, `white_label`)
by entering the broker's scope; a firm sets its own (`trailing_stop`,
`quick_trading`, `mobile_trading`) — and two enforcements, stated on every flag:
server (the API refuses with `FEATURE_DISABLED`) or client (a product choice the
apps honour, never a control). Enforced in the order path (a venue-routed
account with external execution off is refused, never quietly filled
internally), in position modification (setting a trail; clearing stays open),
and in webhook registration. `/admin/features`, with the platform picking a
broker from its own tenant. [feature-flags.md](./feature-flags.md).

**Backups and disaster recovery — done.** A `backup` service in the production
stack: `pg_dump -Fc` every six hours to a host path, each dump parsed before it
is named, pruning only after a verified dump — the ordering a deployment test
pins. `docs/disaster-recovery.md`: what each component holds, why
`SECRET_ENCRYPTION_KEYS` is the row that ends a firm, the restore in order, the
RPO as the interval it is, the RTO as the rehearsal measured it (5.0 s on this
data, dominated by the human steps), and what is deliberately not here —
point-in-time recovery stated as absent rather than implied.

**Graceful shutdown under load — done.** The failure-injection harness gained
a scenario that sends `SIGTERM` while forty orders are in flight. The first run
showed that "graceful" was not: `app.close()` disconnected the database before
it stopped accepting requests, and 36 of 40 failed. The API now drains — a
`DrainState` middleware refuses newcomers with `503`/`Retry-After` and counts
what is inside; the signal handler waits for that count to reach zero (bounded
by `SHUTDOWN_DRAIN_TIMEOUT_MS`), closes idle sockets, then closes the app.
After: 40 filled, 0 refused, exit 1.8 s after the signal. `stop_grace_period`
raised to 40 s on the API, ingest and worker services so Docker does not kill a
process mid-drain. [runbook.md](./runbook.md#draining),
[failure-injection.md](./failure-injection.md).

**Still to do:** separate containers for WebSocket, workers, scheduler and
broker adapters (§77) — ingest and trigger already run apart; secrets manager
integration.

## Phase 15 — Final audit

`docs/final-audit.md` with PASS / PARTIAL / BLOCKED per area, every BLOCKED
item stating what is missing, why, the external dependency, and the interface
or mock already in place (§107).

---

## Sequence and dependencies

```
0 audit ─→ 1 foundation ─→ 2 adapter SDK ─→ 3 external mapping ─→ 9 reconciliation
                │                 │
                ├─→ 4 masters ─→ 5 broker panel
                │
                ├─→ 6 terminal ─→ 7 chart
                │
                ├─→ 8 realtime hardening ─→ 13 observability / load
                │
                ├─→ 10 security ─→ 12 webhooks / developer
                │
                └─→ 11 mobile (blocked at acceptance)
                                          14 production hardening ─→ 15 final audit
```

Phases 4–8 and 10–12 are independent of 2–3 and can interleave; 9 needs 3.

## Total, stated plainly

Roughly **25–30 engineering weeks** of work is described above, of which
Phases 2–3 and 9 end at a boundary this repository cannot cross alone — a
broker's API — and Phase 11 ends at a device this environment does not have.
Everything else is buildable here, in the order given.

## What will not be touched

The PropFA seam (§91, §113): no challenge, profit target, drawdown evaluation,
payout or trader-evaluation logic enters this repository. Future products
consume `DomainEvent`, `RiskRule`, accounts, positions, orders and the ledger.

---

## The previous plan, for the record

Against the standalone-platform specification (August 2026): phases 0–9 done
and deployed (multi-tenancy with RLS, roles as data, web restructure, wallet
and finance, payments, KYC, withdrawals, notifications, API keys and service
tokens), 12 and 13 done (mobile foundation and trading; the APK was never
opened on a device), 10 (webhooks), 11 (Security Centre), 14 (AI context
layer) and 15 (real market data) not started. Those four map onto the new
Phases 12, 10, — (the AI layer is not in the new specification) and 2–3
respectively. `COMPLETION_STATUS.md` records that plan's evidence.
