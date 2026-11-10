# Implementation Plan

> **Product scope correction — 29 October 2026:** the owner defines this as an
> independent trading software platform with an in-house authoritative engine,
> sold/provisioned to brokers and reusable by first-party projects. It is not
> an order-routing client that depends on a broker's execution server. Web,
> Desktop, iOS and Android are in scope. The authoritative definition,
> competitor benchmark, current-state gap matrix and replacement roadmap are
> in [PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md). The phase narratives below
> preserve evidence of work already built; external venue-execution connectors
> are not a remaining product milestone.

**Baseline:** `f630e3e` on `main`, deployed at devopss.ir. 134 test files /
1,787 tests, 18 API smoke checks, 8 WebSocket checks, 69 browser checks, 42
pentest probes — all green.

**Target:** an independent, multi-tenant broker trading software platform with
our own trading engine and Web, Desktop, iOS and Android clients. See the
owner-approved product definition and authoritative delivery order in
[PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md). The 3 September specification
and its sixteen phases below are historical implementation evidence, not the
current product boundary.

**Audit:** [architecture-audit.md](./architecture-audit.md) — what exists,
what is short, what is absent, and the extension point for each.

---

## Read this first

This is the second plan this repository has carried. The first — sixteen phases
against the standalone-platform specification — is complete through its
phase 9 and is recorded at the end of this document; its work is the baseline
above, and nothing in it is undone.

The owner has clarified that the platform itself owns trading execution and
account state. Broker tenant management is in scope; sending trades to a
broker's execution server is not a core dependency. Adapter and external
execution work below is retained as evidence of what was built under the
earlier interpretation. Do not continue that path as a release blocker. The
current delivery order is M0–M5 in [PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md).

## Earlier-plan ordering principle (historical)

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

## Earlier Phase 2 — Broker connection and adapter SDK · **built; venue connector out of current scope**

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

**Historical scope boundary:** the earlier plan treated a real venue connector
as blocked on venue documentation and sandbox credentials. Under the corrected
product direction, that connector is not required; the adapter SDK and mock
remain optional integration scaffolding, not a delivery blocker.

Done as written. `@tp/broker-sdk` (port, capabilities, `ConnectionMonitor`,
`MockBrokerAdapter` with the whole failure catalogue, `brokerAdapterContract`,
credential envelope, registry that refuses an undocumented connector);
`BrokerConnection` and `BrokerCredential` with RLS and immutability triggers;
`/admin/broker-connections` and the Connections screen; the worker's
per-minute health sweep. The real venue connector is out of the corrected
product scope. [broker-adapter-sdk.md](./broker-adapter-sdk.md),
[broker-integration.md](./broker-integration.md).

## Earlier Phase 3 — Broker accounts and external account mapping · **built; external execution is optional**

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

**Built since this was written, and this paragraph did not say so** until
22 September: Reports (`/admin/reports` — a job, a sealed file and a download
that expires, `reports.md`), IP rules (Phase 10, `ip-rules.md`), outbound
webhooks (Phase 12) and the admin view over a person's devices. A plan that
under-reports what exists gets the work done twice; `panel-claims.test.ts` now
reads this paragraph and fails it when it names a feature the code has.

**Not built, and stated as such:** Fees as a section (commission and swap are
edited per instrument; there is no schedule, override or rebate model, and
spread comes from the feed); Alerts (price alerts are Phase 8; admin threshold
rules are not designed); Branding (the `Tenant` model has no visual field;
Phase 14 flags a feature nobody has written). The OpenAPI reference, once on
this list, is built: served behind a session in every environment
(`/developer/openapi.json`); only Swagger's own UI stays development-only, on
purpose.
[broker-panel.md](./broker-panel.md).

**Rechecked 29 October 2026:** the current working-tree edits to admin panels do
not close these gaps. The API still edits commission and swap per instrument,
the risk console reports live threshold exposure but has no configurable alert
rules, `Tenant` has no branding fields, and the production guard still excludes
the API reference. Keep Phase 5 **partial** until the four product/operations
deliverables above have evidence of implementation and acceptance.

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

**Delivered since this phase was first scoped:** the inline watchlist ticket,
categories and Top Movers; stop-limit, trailing and expiry at entry; estimated
swap; Finance and Alerts tabs; selected-position close; the shared level-entry
dialog; a light theme; and a named type scale. The current behaviour and its
browser checks are recorded in [uiux.md](./uiux.md). The earlier gap list was
not kept current and must not be used as the delivery checklist.

**Still open:** a trader Logs tab has no agreed design or distinct purpose;
spacing still uses Tailwind utilities rather than a named scale; and documented
screen-reader paths have not been walked by people using assistive technology.
The automated WCAG audit is useful evidence, but does not close that manual
acceptance gap. Visual acceptance against the MetaTrader, cTrader and
TradeLocker workflows remains open; use their documented workflows and the
official UI references in `PRODUCT_STRATEGY.md`. Phase 6 therefore remains
**partly done**; product decisions and accessibility acceptance are explicit
remaining work, not implied completion.

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
already shipped in the existing drag work. The timeframe list was 6 of the 7
resolutions the server knew — `30` orphaned in `market-core`, off by default,
accepted by the candles route and answered with an empty chart; since
22 September there is one vocabulary, the server says which of it is served
(`GET /market/resolutions`), the clients build their row from the answer, and
`30` is in the default. [charting.md](./charting.md).

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
adapter interface exposes neither. This external venue comparison was
specific to the prior execution-connector scope; current M2 requires internal
ledger and engine reconciliation, not a broker execution API.

**Rechecked 29 October 2026:** the current worker diff strengthens the internal
ledger check by loading the cached balance, orders, positions, trades and ledger
totals in one `REPEATABLE READ` snapshot. The worker integration suite now also
checks that repeated swap accrual leaves reconciliation clean. This improves
the local accounting comparison; it does not close the external-reconciliation
gaps above. The worker changes have not been run on this checkout.

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

**Latest mobile progress (`f333290` and `f5e5d0f`, 29 October 2026):**
`f333290` adds Android Firebase-config-aware app/build setup and a config check;
`f5e5d0f` fixes the REST client so it builds its API root under `/api/v1`, the
token refresh uses the same root, and request IDs have a fallback for runtimes
without `crypto.randomUUID`. The sign-in screen also surfaces a useful
server/client error. The commits add focused unit tests, but this review did not
run them or verify the app on a phone. Preserve these changes when reconciling
the index: the staged patch deletes the Android app config and its test, removes
the `google-services.json` ignore rule, deletes the API-root and sign-in-error
helpers and their tests, then resets callers and request-ID generation to the
behavior the commits fix.

**Uncommitted mobile scope in this checkout:** the order ticket now builds
market, limit, stop and stop-limit requests and can set a trailing stop at
entry; the Orders tab edits resting orders; the Positions tab supports
selection-based close and reports per-position outcomes. Shared request,
selection and presentation helpers have focused tests in the working copy.
Count these as implementation in progress, not accepted delivery: the changes
are uncommitted, their tests have not been run, and the device walkthrough
remains open. Several of the helpers and tests are also among the staged
deletions listed in the checkout checkpoint below.

### Phase 11 device-acceptance draft — pending QA/product approval

Use a candidate APK built from the reconciled revision and install it on a
physical Android device without Metro. Record device/OS, APK revision and
Firebase-config state with the results. The walkthrough should cover sign-in
and token refresh; account switching without stale account data; market and
resting orders, including stop-limit and entry trailing; pending-order edit and
cancel; protective-level edits; selecting and closing positions; chart
position/level overlays; socket disconnect, reconnect and sequence recovery;
and foreground/background transitions. If push is in the accepted scope, also
verify a real notification on that device with the intended channel and sound;
that run requires the matching Firebase client config and server credentials.
Record any biometric, haptic or confirmation requirements not yet implemented
as explicit scope decisions rather than treating them as passed. iOS acceptance
is a separate gate requiring macOS, Xcode and signing credentials.

## Phase 12 — Broker API, webhooks, developer portal · **done**

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

The two platform event producers, `reconciliation.mismatch` and
`security.alert`, were added after this phase was first marked complete; their
outbox delivery and transaction boundary are covered in
[final-audit.md](./final-audit.md). They are no longer outstanding work.
Service tokens remain read-only by design. A service-actor audit path is not a
Phase 12 deliverable unless write capabilities are introduced in a future
product decision.

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

**Grafana dashboards (§63) — done.** Prometheus and Grafana as a third
compose file, provisioned from files in the repository: one dashboard of
twenty-one panels over the metric set, and alert rules for what the runbook
says to be woken for. Grafana on the loopback interface only, reached over an
SSH tunnel. A deployment test checks every metric a panel or alert names
against `MetricsService`, so a dashboard cannot chart a metric nobody emits.
Enabling it in production needs `GRAFANA_ADMIN_PASSWORD` set by the operator.
[observability.md](./observability.md#dashboards-and-alerts-63).

**Still to do:** a deployment-shaped acceptance run at 1,000 traders / 5,000
sockets. The same-two-core run in [capacity.md](./capacity.md) was a useful
stress diagnostic, not a capacity pass: it exceeded the box's serving budget
and identified the need for a separate generator plus scaled serving instances
behind the edge. The current `scripts/load-test.ts` is still local-only: it
hard-codes loopback and starts its own ingest and serving API processes. Add or
provide a mode that targets the §77 deployment, then record correctness,
latency, quote age, safe refusals and socket sequence gaps on that topology.

## Phase 14 — Production deployment hardening · **done**

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

**Container separation (§77) — done as far as the code has parts.** The
WebSocket is served by `api-ws`, its own containers behind Nginx's `/ws`; the
worker has a role (`WORKER_ROLE` all / scheduler / processor, a processor
narrowed by `WORKER_QUEUES`, an undeclared name refused at boot) so the queue
that needs hands can be scaled without every copy re-registering every cron;
ingest and the trigger engine were already apart. Deployment tests pin the
route and the flags; the worker smoke boots a narrowed processor on the real
build and reads which queues it attached. The broker adapter mock runs
in-process as historical integration scaffolding. Packaging a real venue
connector is outside the corrected product scope.

**Secrets from files — done; a manager's API — deliberately not.** Every
secret the platform reads may arrive as `VARIABLE_FILE=/run/secrets/…`, the
convention Docker secrets, Kubernetes secrets, Vault Agent and External
Secrets all deliver; resolved as the first import of both entry points (the
config module validates at import time — found by the worker smoke), only for
an explicit list of secrets, with every ambiguity a refusal by name and never
by value. Boot log names which variables came from files. A direct client for
Vault / AWS / GCP / Azure is an operator's choice tied to where the platform
runs, and would start with that manager's documentation; stated as such.
[secrets.md](./secrets.md).

**Phase 14 is complete.**

## Phase 15 — Final audit · **done**

`docs/final-audit.md` with PASS / PARTIAL / BLOCKED per area, every BLOCKED
item stating what is missing, why, the external dependency, and the interface
or mock already in place (§107). The historical audit listed three BLOCKED
areas: a real venue connector (§10–11), the TradingView indicator and drawing
set (§26–27), mobile acceptance on a device (§105). The venue connector is now
out of target; client and device acceptance remain in the current roadmap.
Written against the build,
with the gates that verified it, and the three faults the audit itself found
and fixed.

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

## Current delivery queue

This is the working priority roll-up of the phase statuses above and the
decision list in [final-audit.md](./final-audit.md). It is not a separate
definition of scope.

### Checkout checkpoint — 29 October 2026

The local `HEAD` is `f5e5d0f`, including recent mobile fixes. Read-only GitHub
API checks on 29 October confirm that `f5e5d0f` is also the head of remote
`main`; it has no associated PR. The legacy commit-status endpoint has no
entries; GitHub Actions reports the two checks below. The
remote feature branch `feat/m1-realtime-terminal` is stale at `441273c` (18
September 2026), so it is not the publication path for this checkout. On
`f5e5d0f`, the 29 October GitHub Actions run passed Docker image builds but
failed `pnpm audit --audit-level=high`: 48 findings (4 critical, 14 high, 27
moderate, 3 low). The critical findings include Next.js image optimization
RCE on `apps/web>next`, two `tinypool` RCE advisories and `shell-quote` command
injection; high findings include vulnerable `node-forge`, `vite`, `body-parser`,
`multer`, `undici`, `zod`, `sharp` and Next.js DoS. Lint, format, typecheck,
migrations, tests, build and smoke checks were skipped after the audit failed.
The Next.js SVG RCE needs separate reachability triage before assigning it as
an exploitable production incident: the current `next.config.ts` does not
enable `dangerouslyAllowSVG` (which defaults to disabled per the
[Next.js Image docs](https://nextjs.org/docs/app/api-reference/components/image#dangerouslyallowsvg)),
source search found no `next/image` usage, and
the production Docker stage starts from `node:22-alpine` without the
build-stage `libc6-compat` package. The advisory describes RCE on glibc-based
Linux and recommends `sharp >=0.35.5` as a workaround
([GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw));
the committed lockfile has `sharp@0.35.4`. These source-level facts narrow the
known exposure but do not replace checking the deployed image's runtime libc
and endpoint behavior. Keep the CI audit gate enabled and upgrade the package.
The older 11 October dependency PR run is not current evidence; its two-high
finding count is superseded by this audit. `main` is unprotected and has no
required status checks. Treat dependency remediation and a fresh full CI run
as a **P0 release gate**. This result covers committed `f5e5d0f` only, not the
uncommitted checkout described below.

**Production build check — 29 October 2026:** the public `/status` page
reported API and Web on the same build, digest `1f8773ca6ee6`. The repository's
`buildMarker()` is the first 12 hex characters of SHA-256 over the full
`BUILD_SHA`; computing that rule for `f5e5d0f660132ffa6e5407347a9c415d6d98034b`
produces the public digest exactly. This confirms the currently serving API
and Web are on the audited `f5e5d0f` commit. The public liveness route separately
reported API `up`; it does not prove database, feed or order-path health. The
dependency issue is therefore a **production remediation priority**, while the
exact reachability of individual advisories still needs per-package triage.

**Security exposure triage against `HEAD` (`f5e5d0f`):**

| Finding group                                       | Repository evidence                                                                                                                                                                                                                                                                                                                                                                                                                                              | Delivery treatment                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body-parser` high                                  | At audited `HEAD`, API locks `2.3.0`; Nest creates the default Express parser with `rawBody: true` and no custom body-parser options. The advisory says a single malformed compressed request can crash the process before routing, without authentication. The local candidate now overrides it to `2.4.0`; the fresh audit no longer reports this advisory.                                                                                                    | **Immediate production hotfix candidate is prepared, not deployed:** retain `2.4.0+`, add a regression for process survival and API parsing, then ship through CI. [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)                                                                                                               |
| `zod` high                                          | At audited `HEAD`, the API resolves `4.6.5`; `ZodValidationPipe` is global and controllers use Zod DTOs. All API array schemas have `.max()`, but in the vulnerable version the bound ran after element parsing, so the cap alone does not prevent issue accumulation. The local candidate updates the workspace catalog and lock to `4.6.7`; the fresh audit still reports a high Zod finding along the mobile Expo CLI chain, which needs separate resolution. | Keep `4.6.6+`, identify and update the remaining Expo-chain resolution, and add a large invalid-array regression before closing this item. The upstream patch moves size-bound checks before parsing elements. [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [upstream fix](https://github.com/colinhacks/zod/commit/a0ebf97) |
| `multer` high                                       | Transitive through `@nestjs/platform-express`; source search found no file-upload interceptor or uploaded-file route.                                                                                                                                                                                                                                                                                                                                            | Upgrade with the runtime dependency set; do not claim a reachable upload path without evidence.                                                                                                                                                                                                                                                           |
| Next.js critical/high                               | `next` is in the Web runtime. Source search found no Server Actions or `next/image`; SVG optimizer is not enabled. Production Web stage is Alpine and omits build-stage `libc6-compat`.                                                                                                                                                                                                                                                                          | Upgrade regardless; confirm deployed runtime conditions and route behavior before classifying the specific advisories as exploitable.                                                                                                                                                                                                                     |
| `sharp` high                                        | Transitive through Next; lockfile is `0.35.4`, advisory fix is `0.35.5+`.                                                                                                                                                                                                                                                                                                                                                                                        | Upgrade with Next; verify the production image and image-processing behavior.                                                                                                                                                                                                                                                                             |
| `tinypool`, `vite`, `source-map-js`, JSDOM `undici` | Test/dev dependency paths. API Dockerfile installs before `NODE_ENV=production`, then copies full root and API `node_modules`; root includes Vitest/JSDOM/coverage.                                                                                                                                                                                                                                                                                              | Inspect API image inventory; prune dev dependencies and verify startup/smoke flows. Do not assume absent from production.                                                                                                                                                                                                                                 |
| Expo `node-forge`, React Native `shell-quote`       | Paths originate from mobile/Expo; API Docker build context does not copy `apps/mobile`.                                                                                                                                                                                                                                                                                                                                                                          | Keep in repository audit remediation; separate mobile build/CI exposure from API image exposure.                                                                                                                                                                                                                                                          |

The current API image copies unpruned dependency trees, while Web uses Next
standalone output and a different dependency-tracing path. Add a production
dependency packaging step and an image package inventory to the security
remediation. Reachability checks refine urgency; they do not waive the audit
failure or remove the need to upgrade affected packages.

The checkout has active implementation work across API, worker, web, mobile,
shared types, trading and market packages, Prisma, and scripts: 139 tracked
paths have working-tree changes and 54 paths are untracked. The index contains
191 staged paths; 137 have both staged and unstaged changes. All 54 untracked
paths match the staged deletions and the current `HEAD`; 50 also existed in the
parent commit, while four were introduced by `f5e5d0f` and are now staged for
deletion. The staged patch reverts the mobile sign-in fix in overlapping files:
it drops the API-root helper, restores the origin-only REST base and
`crypto.randomUUID()` call, and hard-codes the refresh path. It also deletes the
Firebase-aware Android app config and its test, and removes the
`google-services.json` ignore rule from the staged `.gitignore`. That file is
not present in the worktree now. Across the 54 deletions, the staged patch also
removes web terminal modules, mobile request/position helpers, shared market
and trader-event types, two Prisma migrations and regression tests; this is a
feature rollback as well as a coverage rollback. The current staged snapshot is
backed up and its checksum matches the index. This is not one reviewable
candidate until those states are reconciled.
`git diff --check` and `git diff --cached --check` are clean, but no functional
verification gate has been run against this checkout. Treat M1 as **in progress,
not accepted** until the index is reconciled and the candidate passes its agreed
gates.

The unstaged implementation spans two substantial workstreams: trading changes
to pending-order activation, protective levels, positions, account/session
handling and mobile order flows; and terminal changes to watchlists, chart
levels and themes, positions, finance/history, shared UI tokens, admin panels
and their API contracts. Schema migrations and smoke/unit/integration coverage
are also part of the diff. These are observed change areas, not verified
deliverables. Review the order and migration paths together first because a
partial stage or rollback could separate application behavior from its schema;
then validate the end-to-end terminal candidate before visual polish or live
broker integration is called accepted.

**Backlog tracking check — 29 October 2026:** GitHub search returned no open
issues for this repository. PR #2 remains a draft and has no requested
reviewers. The delivery queue below is therefore tracked in this plan, not in
assigned GitHub issues; the accountability table names roles, not people or
committed dates. Do not report those roles as owners until people and dates are
assigned.

1. **P0 — Dependency security gate:** the deployed/main snapshot still has 4
   critical and 14 high findings. The local candidate now resolves
   `body-parser@2.4.0` and Zod `4.6.7`; a fresh registry audit fell to 46 total
   findings (4 critical, 12 high, 27 moderate, 3 low), and no longer reports
   the body-parser advisory. It still reports a high Zod finding through
   `apps/mobile>expo>@expo/cli>zod`, so Zod is not fully cleared. Neither
   candidate change is deployed. Next resolve the remaining Zod path and the
   critical/high packages, then rerun the full CI gate. The API's `.max()`
   array checks did not protect Zod `4.6.5` because its size check ran after
   element parsing.
   Keep the audit enabled; the current CI stopped before lint, typecheck,
   migrations, tests, build and smoke checks. [PR #2](https://github.com/agparsa/trading-platform/pull/2)
   is still draft and is based on an older `main`; its overrides cover
   `tinypool`, `shell-quote`, `source-map-js` and `sharp`, but not the current
   critical Next.js finding or several other packages in the latest audit.
   The committed lockfile versions include `next@15.5.25` (audit fix
   `15.5.28+`), `vite@7.3.6` (`7.3.7+`), `body-parser@2.3.0` (`2.4.0+`),
   `multer@2.4.0` (`2.5.0+`), `undici@8.10.2` (`8.12.2+`),
   `zod@4.6.5` (`4.6.6+`), `sharp@0.35.4` (`0.35.5+`),
   `source-map-js@1.2.1` (`1.2.2+`), `shell-quote@1.10.0` (`1.11.0+`)
   and `tinypool@1.1.1` (the PR pins `2.1.2`). The existing
   `multer: ^2.3.0` override still resolves to 2.4.0, below the audit's fix.
   Rebase/reassess PR #2's scope before treating it as the fix for this gate;
   `node-forge` currently has no patched version listed by the registry audit.
2. **P0 — Candidate integrity:** reconcile the staged patch and working tree
   into one reviewable candidate. The saved patch preserves the staged state;
   do not sign off or commit while the index contains a different implementation
   and deletions that remove committed fixes, including mobile sign-in.
3. **Trading behavior and schema review:** inspect the order, protective-level,
   position, session and migration changes as one unit. The working copy
   contains focused coverage for stop-limit activation/gaps/modify races,
   trailing-at-entry, and external-account rejection of pending orders. Those
   integration files are restored copies of `HEAD`, while the index stages
   their deletion; decide which state is intended before relying on or removing
   them. No functional gates have been run for this checkout; run the agreed
   verification only after there is one candidate to verify.
4. **Live-market prerequisites:** the market-data provider defaults to the
   internal simulator, and `external` is not implemented. Select and integrate
   a licensed feed before describing the deployed service as a live-market
   platform. Broker onboarding and account/configuration exchange remain in
   scope; connecting order execution to a broker venue and reconciling against
   that venue do not. Terminal UX can progress against the simulator, but that
   does not count as acceptance with an authorized live market feed.
5. **Terminal acceptance:** Phase 6 is partial. The owner-approved product
   boundary is in `PRODUCT_STRATEGY.md`; the exact acceptance walkthroughs
   across Web/Desktop/iOS/Android still need to be recorded. The code/design
   gaps named here are a Logs tab decision, a spacing scale, and manual
   screen-reader acceptance.
6. **Chart decision (Phase 7):** choose a TradingView licence or accept the
   open-source charting target; that choice determines whether the blocked
   indicator and drawing set proceeds.
7. **Acceptance resources:** Phase 11 needs a physical Android device (and
   macOS, Xcode and a signing key for iOS). Phase 13 needs a deployment-aware
   load-harness mode, a separate generator host, and scaled WebSocket-serving
   instances behind the edge for the 1,000-trader / 5,000-socket scenario.
8. **Broker operations (Phase 5):** Fees, admin threshold alerts, Branding and
   production API documentation remain partial. Production settings and
   operator decisions stay itemized in the final audit.

### External decisions and accountable roles

The repository names no individual owners, so these are role assignments
inferred from the dependency, not named commitments. Assign people before
turning the dates into a release forecast.

| Item                                         | Accountable role                                      | Evidence that closes it                                                                                                                   |
| -------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Single reviewable candidate                  | Repository owner / release lead                       | One agreed staged revision; no unintended deletions; candidate commit or review ref                                                       |
| Detailed flows and visual target             | Product owner                                         | Approved Web/Desktop/iOS/Android flows derived from the MetaTrader, cTrader and TradeLocker benchmark, with explicit deferrals            |
| Engine and client acceptance                 | QA / product acceptance owner                         | Required verification gates pass on the candidate; manual account/order/position walkthrough across supported clients                     |
| Licensed market feed                         | Product / commercial owner and market-data integrator | Source selected and licensed; provider integration and freshness/continuity evidence                                                      |
| Broker onboarding and configuration contract | Product / broker integration owner                    | Versioned user/account provisioning, identity, instrument/configuration and market-data contracts; no upstream order-execution dependency |
| Chart library and indicators                 | Product owner                                         | TradingView licence decision or written acceptance of the open-source chart target and its feature scope                                  |
| Mobile acceptance                            | Mobile QA owner                                       | Physical Android walkthrough; iOS additionally requires macOS, Xcode and signing credentials                                              |
| 1,000-trader / 5,000-socket capacity run     | Infrastructure / performance owner                    | Deployment-targeting harness mode; separate generator host; scaled serving topology; run report with correctness and capacity results     |
| Phase 5 broker operations                    | Product / operations owner                            | Fees, alert thresholds, branding and production API documentation decisions recorded                                                      |

### Earlier Web-terminal acceptance draft — subordinate to the corrected roadmap

The owner approved the independent-platform product boundary on 29 October 2026. This older proposal only covers a Web-terminal walkthrough on the
internal simulator; it is an input to M4, not acceptance of the whole product,
and does not cover Desktop, iOS, Android, or a production market-data source.

**Public deployment probe — 29 October 2026:** opening
`https://devopss.ir/terminal` in a browser reached the deployed site and
redirected to `/login`, where the sign-in form rendered. This confirms the
unauthenticated web entry point is reachable; no authenticated terminal, API,
mobile or trading flow was verified. A credentialed QA pass is still required
for those claims.

- Walk the browser flows against API-backed simulator data: switch accounts;
  search, filter and stage an order from the watchlist; place and manage market,
  limit, stop and stop-limit orders; edit protective levels; view and close
  positions; and inspect Finance, Alerts and order history/trails.
- Verify loading, empty and error states, plus the terminal at the documented
  responsive widths. Use the cTrader/TradeLocker/MetaTrader workflows named in
  `PRODUCT_STRATEGY.md` as the benchmark; any feature deferral needs to be
  recorded before visual sign-off.
- On the candidate revision, require `pnpm verify`, `pnpm smoke` and
  `pnpm smoke:web` to pass; run `pnpm smoke:ws` where the realtime path changes.
  These gates have not been run for the current working revision.
- Coverage boundary: the current working-tree `smoke:web` walks watchlist
  staging, categories and Top Movers; checks the watchlist layout at 1,100,
  1,440 and 1,680 px; and reads back Alerts, Finance against the ledger, and
  order trails. It does not exercise account switching, stop-limit placement
  and activation, or selected-position close end to end. There is narrower
  unit/component/integration coverage for several of these paths, but some of
  those test files are untracked in the current checkout and staged for
  deletion. If they are in M1, retain that coverage in the reconciled candidate
  and include the browser paths in the acceptance walkthrough.
- Keep the Logs tab, spacing scale and manual screen-reader walk open unless
  the product owner explicitly accepts them as deferred. Automated WCAG checks
  do not substitute for that manual acceptance.
- Reconcile the staged patch with the working tree before M1 sign-off or
  commit; the current index contains deletions that remove terminal and trading
  behavior present in the working files.

## Previous-scope estimate (superseded)

The **25–30 engineering weeks** figure below this section described the prior
multi-broker execution-connector scope. It is not a forecast for the
owner-corrected product. Re-estimate after M0 establishes a clean candidate and
M1 closes the product and integration decisions in
[PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md).

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
