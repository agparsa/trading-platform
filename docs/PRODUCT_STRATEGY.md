# Product strategy and competitor benchmark

**Owner direction recorded:** 29 October 2026. This document supersedes the
earlier interpretation of the product as an execution aggregator or a system
whose next milestone is connecting to a broker's trading server.

## Product definition

We build and own an independent, real-time trading software platform. Brokers
are customers and tenants: they connect their business and bring their traders
to the platform. Traders use our clients while our server-side engine owns
account trading state, order and position lifecycles, pricing calculations,
margin, risk checks, and the authoritative event history. The platform is
intended for our own future projects at no charge and for provision to other
brokers as a software product.

The client surfaces in scope are **Web, Desktop, iOS, and Android**. A broker
must be able to provision or connect its users and accounts, configure the
trading environment and risk limits, and support its users without replacing
our trading engine with the broker's order execution API.

### Product boundaries

- **In scope:** our execution and account engine; multi-tenant broker
  administration; trader terminal; cross-device account state; broker
  provisioning and control-plane APIs; realtime market and account updates;
  operational tooling and broker deployment/onboarding.
- **Not a core dependency:** sending each trader order to a third-party
  broker's execution server. Existing `EXTERNAL_BROKER` code is a previously
  built optional path, not the target architecture or a release blocker. Do
  not add venue execution connectors as roadmap work without a new product
  decision.
- **Still to decide before live-money launch:** the licensed market-data source
  and entitlement model; how broker-supplied users/accounts/settings enter our
  system; the legal and financial responsibility boundary between our
  software and a broker; and whether the first broker deployment is hosted,
  self-hosted, or supports both. A market-data feed can provide prices without
  becoming the order-execution engine.
- **Internal reuse:** first-party projects can use the platform without a
  per-broker commercial charge. Packaging and commercial terms for external
  brokers remain a separate product decision.

“No errors” is an aspiration, not a measurable release gate. The release
contract must instead prohibit lost, duplicated, or silently mis-stated trade
state and set numeric availability, order-response, tick-to-client, recovery,
and error-budget targets before a production scale claim is made.

## Public product benchmark

This is a feature and operating-model benchmark from the vendors' public
documentation. It is not a request to copy their private APIs, server designs,
branding, or licensed charting assets.

| Reference                                                                                                                                                                               | What the official material documents                                                                                                                                                                                                                                             | Product lesson for us                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MetaTrader 5 for brokers](https://www.metatrader5.com/en/brokers)                                                                                                                      | A broker-oriented, multi-asset platform with its own server and manager functions, risk and trade-condition controls, gateways, reports, APIs, and desktop/web/mobile clients. Its broker package also describes algo trading and integrations.                                  | The benchmark includes the broker control plane and server operations as well as the trader terminal. We must own the order/account engine, tenant boundaries, deployment, configuration, and diagnostics.                                                            |
| [cTrader interface](https://help.ctrader.com/ctrader/interface/basics-and-layouts/) and [Open API](https://help.ctrader.com/open-api/)                                                  | Account switching, watchlists, multi-chart workspaces, chart trading, positions/orders/history, alerts and market-depth tools across its clients. Open API exposes live data and trading operations through the cTrader backend and has published request limits.                | Use its cross-device workflow and realtime screen behavior as UX benchmarks. Do not build our core as a client of cTrader's backend; our own engine and event stream remain authoritative.                                                                            |
| [TradeLocker platform](https://support.tradelocker.com/en/articles/14597099-what-is-tradelocker) and [broker connectivity](https://tradelocker.com/integrate-tradelocker/connectivity/) | TradeLocker describes itself as a platform provider; brokers own accounts, funds, conditions, and execution decisions. Its broker connectivity includes account provisioning/management APIs and realtime BrandSocket updates. It offers Web, Desktop, iOS, and Android clients. | This is the closest software-vendor operating model. Build broker onboarding/control-plane and multi-client access around our own engine. Keep broker API integration for tenant/user/account/configuration and agreed data exchange, not order execution dependency. |

### Official UI reference images

Use these vendor-hosted images as workflow/layout references during M4 design
and acceptance. They are not pixel-perfect implementation specs or assets to
copy into this product.

- [MetaTrader 5 Web terminal](https://www.metatrader5.com/i/web-trading/web-trading-how-to-connect.png) and [desktop terminal](https://www.metatrader5.com/c/17/1/terminal-chart.png).
- [cTrader main trading workspace](https://help.ctrader.com/ctrader/img/basics-and-layouts-4.png).
- [TradeLocker charting workspace](https://tradelocker.com/wp-content/themes/tradelocker-child/redesign/charting%402x.png).

## Technical benchmark by platform

The following details come from public vendor manuals and API references.
They describe public integration contracts, not reverse-engineered server
internals.

### MetaTrader 5

- **Broker stack:** the official broker material describes a full-cycle
  deployment with trade/history servers, manager/report/server/gateway/web
  APIs, exchange and liquidity-provider gateways, broker roles, and configurable
  margin, contract, session, spread, markup and commission parameters. It is
  designed to run on broker-controlled infrastructure.
- **Trading contract:** the MQL5 reference separates preflight (`OrderCheck`)
  from submission (`OrderSend`); a successful submission call is not proof of
  fill. The client must inspect server return codes and process later trade
  transactions. The platform supports netting and hedging account models and
  a large set of order/position operations.
- **Automation:** MQL5 IDE, Expert Advisors, indicators, Strategy Tester,
  optimization and Python integration are first-class ecosystem features.
- **Our implication:** plan server-side order acceptance separately from
  execution/fill events, preserve an auditable lifecycle, and treat automation
  and strategy testing as a later product module after the core release.
- **API families:** MetaTrader's broker documentation lists Report, Server,
  Gateway, Manager and Web APIs. These extend or operate a broker's licensed
  MetaTrader server stack; the public broker page is not a portable client API
  for sending our own platform orders to MetaTrader.

### cTrader

- **Trader workflow:** official UI documentation describes account switching,
  watchlists, multiple charts, chart orders, Trade Watch for positions/orders/
  history, alerts, market-depth tools and visible session/server/proxy
  latency. Windows, Mac, Web and Mobile clients share account concepts.
- **API contract:** Open API supports JSON or Protobuf over TLS TCP or WebSocket,
  account authorization, live spots/bars and permitted order, position and
  history operations. Published request ceilings are 50 non-historical and 5
  historical requests per second per connection; symbol IDs are scoped to a
  broker/server environment. This API talks to the cTrader backend.
- **Broker CRM contract:** a separate WebServices API covers cTrader user and
  account creation/linking, group assignment, symbols/assets and balance
  operations. Full Integration adds broker CRM SSO, embedded Web and in-app
  actions; Spotware documents this as a paid modular add-on. Those APIs connect
  a broker CRM to Spotware's cTrader backend; they are not our own engine API.
- **Automation:** cTrader Algo supports C# and Python cBots, indicators and
  plugins; desktop supports authoring/backtesting/optimization, while existing
  cloud instances can run across clients.
- **Our implication:** benchmark multi-chart workflows, connection/latency
  visibility and cross-client account continuity. Keep IDs and state owned by
  our platform; do not call Open API to execute our platform's orders.

### TradeLocker

- **Operating model:** TradeLocker describes itself as a trading platform,
  while brokers/prop firms own accounts and trading conditions and make
  execution decisions. Broker connectivity documents account management,
  risk setting, back-office access and a separate real-time BrandSocket API.
- **Trader API:** the Public API is request/response REST with JWT
  authentication for orders, positions, historical quotes and account data.
  Responses and requests use account and route identifiers; per-route limits
  and history/quote row limits are documented. Order IDs and position IDs are
  distinct, and a filled order transitions into history while a position is
  tracked separately.
- **Broker APIs:** Brand API handles brokerage-side onboarding/account and
  trading administration, while BrandSocket separately streams balances,
  equity, positions and orders. This is distinct from the trader Public API.
- **Realtime API:** Streams uses Socket.IO/WebSocket, one connection can carry
  multiple accounts, and each subscription begins with an account/position/
  order snapshot followed by a synchronization marker and live events. Clients
  must resubscribe on reconnect and route by brand/account IDs; numeric values
  are decimal strings.
- **Clients and analysis:** Web, Desktop, iOS and Android; chart-first order
  placement, visible SL/TP and risk sizing, portfolio/open/pending/closed
  position views, and desktop algo workflows.
- **Our implication:** the broker-facing control plane and event stream are
  central product surfaces. Define stable account/order/position IDs and
  snapshot-plus-replay semantics, but keep our own engine as the execution and
  state authority.

### Common engineering requirements extracted from the manuals

1. An accepted order and a filled order are different states; the API must
   return explicit result codes and publish subsequent lifecycle events.
2. Orders, executions/deals, positions and history need distinct identifiers
   and query surfaces; filling an order does not erase its audit trail.
3. Account mode, instrument contract, quote precision, session, fees and risk
   configuration change trading behavior and must be server-owned data.
4. Realtime clients need an initial snapshot, sequence/cursor or equivalent
   catch-up point, reconnect/resubscribe, deduplication and explicit stale-data
   states.
5. Broker control APIs and trader APIs need separate credentials, permissions,
   rate limits and audit trails.
6. Desktop automation, backtesting, marketplace/social features and advanced
   chart libraries can follow a stable trading MVP; they must not delay engine
   correctness or cross-client order-state consistency.

## API strategy for our product

The references establish three different integration surfaces. We should offer
our own explicitly separated contracts, all backed by our own database and
execution engine:

| Our surface             | Consumers                                                      | Contract to build                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Broker Partner API**  | Broker CRM, client portal and operations systems               | Broker-scoped OAuth2/service credentials; create/link users and trading accounts; sync instruments, sessions, contract specs, account modes and risk/fee settings; user identity/SSO; audit of every administrative mutation. No partner credential may directly mutate trade state outside the engine. |
| **Trader API**          | Our Web, Desktop, iOS and Android clients; later approved bots | User/account-scoped REST commands for preview, submit, modify, cancel, close and history; every mutation idempotent with explicit acceptance/refusal and later fill/execution events.                                                                                                                   |
| **Realtime stream**     | All clients and authorized broker operations views             | Snapshot followed by sequenced account/order/position/quote events; resume cursor, heartbeat, resubscribe, dedupe, authorization refresh and stale-feed status.                                                                                                                                         |
| **Market data ingress** | Licensed data source or a broker's authorized price publisher  | Separate authenticated feed protocol with symbol mapping, timestamps, sequence, integrity/freshness checks and replay. It supplies prices only; it cannot execute or author order state.                                                                                                                |

This separation gives a broker the account and configuration control surface it
expects from MT5/cTrader/TradeLocker while preserving the user's requirement:
orders and resulting account state are processed by our engine. The existing
API, API keys, webhooks, tenant roles and Socket.IO infrastructure are a base;
the versioned broker-facing provisioning/configuration contract and its
acceptance suite remain a roadmap item.

### Official technical sources

- MetaTrader 5 [broker/server/API architecture](https://www.metatrader5.com/en/brokers), [order submission lifecycle](https://www.mql5.com/en/docs/trading/ordersend), [preflight check](https://www.mql5.com/en/docs/trading/ordercheck), and [Python integration](https://www.mql5.com/en/docs/python_metatrader5).
- cTrader [interface and trading workflow](https://help.ctrader.com/ctrader/interface/basics-and-layouts/), [Open API](https://help.ctrader.com/open-api/), [Open API authentication](https://help.ctrader.com/open-api/account-authentication/), [WebServices API](https://docs.spotware.com/webservices-api/), [Full Integration](https://docs.spotware.com/full-integration/), and [Algo/cBot workflow](https://help.ctrader.com/ctrader-algo/documentation/cbots/).
- TradeLocker [platform/provider boundary](https://support.tradelocker.com/en/articles/14597099-what-is-tradelocker), [broker connectivity](https://tradelocker.com/integrate-tradelocker/connectivity/), [Public API](https://public-api.tradelocker.com/docs/getting-started), and [BrandSocket API](https://api.tradelocker.com/brand-api/socket/docs/).

### Cross-platform acceptance scope

The benchmark is organized as deliverable capabilities rather than a claim of
feature-for-feature parity with every vendor:

1. **Trading core:** market, pending and protective orders; modify/cancel;
   partial/full close; hedging/netting account semantics; exact money and
   contract calculations; margin, stop-out, fees and history.
2. **Market workspace:** streaming quotes, watchlists, instrument search,
   synchronized chart state, indicators/drawings decision, chart orders,
   depth-of-market where the selected feed supports it, alerts and market
   sessions.
3. **Broker operations:** tenant setup; user/account provisioning; instruments,
   trading conditions, permissions and risk ceilings; live operational book;
   audit, reports and support diagnostics.
4. **Client consistency:** Web, Desktop, iOS and Android must show the same
   server-owned account/order state and recover correctly after disconnect,
   app suspension, account switch and reconnect.
5. **Reliability:** idempotent commands, ordered/replayable events, explicit
   unknown outcomes, no double application, durable ledger/history, recovery
   drills and agreed SLOs measured under target load.

## Current repository against this product

Evidence checked at `f5e5d0f` on 29 October 2026 and against the current
working tree. Presence in source does not by itself prove production
acceptance.

| Capability                       | Current evidence                                                                                                                                                    | Product status                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned trading engine             | Internal order, position, trigger, ledger, margin and risk paths in API/domain packages.                                                                            | Substantial core exists; re-establish one clean candidate and rerun the complete gates before calling it release-ready.                                                                   |
| Broker tenants and hierarchy     | Platform/broker tenant kinds, roles, desks/master links, risk hierarchy, broker administration routes.                                                              | Foundation exists; broker panel and onboarding remain partial.                                                                                                                            |
| Broker-side execution dependency | `EXTERNAL_BROKER`, broker adapter SDK, external account mapping, outbox/inbox, mock adapter.                                                                        | Does not match the clarified target as a core path. No real venue connector is required by this product direction. Keep disabled/isolated until an explicit integration need is approved. |
| Live market data                 | Deterministic internal simulator and provider port; no licensed production feed is recorded.                                                                        | Open launch dependency; choose source, rights, instruments, entitlements, freshness and fail-safe behavior.                                                                               |
| Web                              | Next.js terminal and substantial admin routes/components.                                                                                                           | Exists; the implementation plan records terminal UX and product-acceptance gaps.                                                                                                          |
| Desktop                          | No desktop app is present in the four application directories.                                                                                                      | Not built. Select a packaging/runtime approach after the Web client contract is stable.                                                                                                   |
| Android / iOS                    | Expo mobile app is present. The completion record says it has not been built and accepted on a physical device; iOS acceptance needs Apple build/signing resources. | Android incomplete acceptance; iOS unverified/not accepted.                                                                                                                               |
| Realtime and operations          | Socket.IO/Redis infrastructure, sequence numbers, health probes, metrics, load/failure tooling.                                                                     | Substantial foundations; current dependency audit fails CI before the other gates, and production-scale targets remain unverified.                                                        |

## Authoritative delivery roadmap

This roadmap replaces the old “connect a real broker execution venue” path.
The numbered phase write-ups later in `IMPLEMENTATION_PLAN.md` remain useful
as records of code already delivered, but their connector milestones are not
future acceptance criteria.

### M0 — Stabilize the current candidate (P0)

- Reconcile staged, unstaged, and restored files into one reviewable source
  state; do not let this obscure or erase existing product work.
- Finish dependency remediation, retain an explicit exception list for
  advisories without a fix, then get the complete CI, database, API, Web and
  deployment checks green on that exact candidate.
- Verify the deployed revision and smoke the user journey against it.
- **Exit:** one identified commit, clean review, all required gates green, and
  deployment evidence tied to that commit.

### M1 — Freeze the platform and trading contracts (P0)

- Specify account modes (hedging/netting), symbols/contracts, quote semantics,
  order types, fills, fees/swaps, margin/stop-out and trading calendar.
- Define the inbound broker contract: tenant onboarding, user/account
  provisioning, identity/SSO, configuration synchronization, roles and
  market-data exchange. Explicitly exclude upstream order execution.
- Decide feed ownership/licensing, hosting model, broker responsibility and
  first-party reuse terms.
- **Exit:** reviewed domain/API contracts, decision log closed for release
  blockers, and acceptance scenarios shared by engine and clients.

### M2 — Prove engine correctness and recovery (P0)

- Preserve the in-house engine as the only order/position state authority.
- Replay deterministic quote/event sequences through orders, triggers,
  positions, ledger, margin, restart and reconnect paths.
- Prove concurrency, precision, duplicate-command and duplicate/out-of-order
  event handling against database-backed integration scenarios.
- **Exit:** invariant suite and fault/restart scenarios pass on the same
  release candidate; no silent loss, duplicate fill, or ledger drift.

### M3 — Broker onboarding and operating console (P1)

- Complete broker self-service or assisted onboarding, user/account creation
  and sync, account configuration, instruments/sessions, risk/fees/permissions,
  support views and audit/reporting.
- Add documented, versioned broker APIs and event/webhook contracts for
  provisioning and agreed market/configuration data.
- **Exit:** a broker can onboard, configure, support and audit a tenant without
  using an external broker execution server.

### M4 — Complete client products (P1)

- Close Web terminal acceptance gaps against the benchmark workflows.
- Choose and build the Desktop client; complete physical-device Android and
  iOS builds, signing, store/distribution and reconnect acceptance.
- Share API contracts and server-owned state across every client.
- **Exit:** the core trader journeys pass on Web, Desktop, iOS and Android.

### M5 — Production market data, reliability and launch (P1)

- Select and contract the market-data source; implement entitlement, feed
  integrity, freshness, replay and safe refusal behavior.
- Set measurable SLOs and prove latency, availability, reconnect, backup/restore
  and target-load behavior on production-like topology.
- Document broker onboarding, support, upgrades, incident response and
  first-party deployment.
- **Exit:** the agreed broker pilot checklist passes with real authorized data
  and an identified production owner.

### Decisions and schedule

The remaining external inputs are: market-data rights/source; the broker
identity/account/configuration protocol; hosting model; Desktop runtime;
Android/iOS signing and device acceptance; and numeric production SLOs. The old
“25–30 engineering weeks” and “nine to twelve months” figures were estimates
for earlier scopes. They are not a forecast for this corrected product. Build
the estimate only after M0 has one stable candidate and the M1 decisions are
recorded.
