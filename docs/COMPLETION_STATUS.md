# Completion status against the MASTER PROMPT

> This document tracks the **earlier** standalone-platform specification. The
> repository is now planned against the multi-broker specification of
> 3 September 2026 — see [architecture-audit.md](./architecture-audit.md) and
> [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md). The evidence below stands.

Measured against the working tree, not against memory. Every figure below comes
from a command run against this repository.

> **This document went stale once, silently.** Three rounds of edits to it were
> string replacements that stopped matching after Prettier reformatted the
> tables, so the file kept saying "there is no mobile app" while the mobile app
> was being committed around it. It is now regenerated from measurement rather
> than patched. If you are editing it, re-measure — do not trust the prose.

**Short answer: the master prompt is not complete.** Four of sixteen planned
phases are done _as of 3 September 2026_ — a judgement, not a measurement, and
the only figure on this page that is neither counted nor checked. It sits two
paragraphs above a block of measured numbers, where it reads like one of them,
so it carries its own date: a reader taking it as today's is the mistake this
document has already made once with everything else.
`docs/IMPLEMENTATION_PLAN.md` estimates **nine to twelve months for one
engineer**, and nothing has happened to make that estimate wrong.

## The evidence baseline

**The block below is generated.** `pnpm measure` prints it and
`pnpm measure --write` replaces it; `scripts/repository-figures.test.ts` fails
the build when its structural counts stop matching the working tree.

It is generated because the warning at the top of this document came true a
second time. Every figure in the hand-written baseline was roughly half of
reality — 141 test files against 226, 1,903 tests against 2,970, 16 packages
against 20, 52 Prisma models against 70, 161 routes against 237, 78,000 lines
against 151,000 — and each looked specific enough to be believed. A status
document that under-reports by half is worse than none, because specificity
reads as currency.

<!-- measured:begin -->

**4 applications** (`api`, `web`, `worker`, `mobile`) and
**20 workspace packages**, on **70 Prisma models**
with **55 migrations** applied, serving **240 API routes**.

Roughly **152,000 lines** of TypeScript across
782 files.

Counted at `0763e538` on 2026-09-22 by `pnpm measure`. The
structural counts above are checked against the working tree on every build;
the line and file counts move with every commit and are as old as the date
beside them.

<!-- measured:end -->

Live at https://devopss.ir.

The route count was once 95 here and 84 in `docs/API_INVENTORY.md`'s
hand-written header while the generated table in that same file listed 94. Every
hand-written figure is gone now; the generated ones are all that is left.

## Built, tested, and running

Complete in the sense the prompt defines — UI → API → business logic → database
→ authorization → security → audit → tests.

| §        | Area                       | Evidence                                                                                                                                                                                                                |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2        | Repository audit           | 8 documents in `/docs`, every figure produced by a command                                                                                                                                                              |
| 4        | Multi-tenancy              | `Tenant` model, `tenantId` on 32 models, `AsyncLocalStorage` scope, Prisma client extension, **row-level security enforced against the application**, cross-tenant pentest probe                                        |
| 5        | Database                   | PostgreSQL 16, Prisma 6, `NUMERIC(28,10)`, **zero float columns**, enforced in CI                                                                                                                                       |
| 7        | Authentication             | password hashing, refresh rotation in httpOnly cookies, TOTP 2FA with recovery codes, sessions, device and IP visibility, rate limiting                                                                                 |
| 11       | Trading engine             | market / limit / stop, SL/TP trigger engine, modify, cancel, partial close, PnL, equity, margin, leverage, commission, spread, swap accrual                                                                             |
| 12       | Risk engine                | deterministic, `risk-core` framework-free and unit-tested                                                                                                                                                               |
| 13       | WebSocket                  | authenticated, heartbeat, reconnect, subscriptions, tenant isolation, shared market-data infrastructure                                                                                                                 |
| 14       | **Mobile application**     | `apps/mobile` — Expo SDK 57, 14 screens, auth with 2FA, push, sounds, chart. **Never built for a device** — see below                                                                                                   |
| 15,21,22 | **Push notifications**     | FCM HTTP v1 for Android and web, APNs over HTTP/2 for iOS, delivery records, retry/drop classification, a client that registers and deduplicates                                                                        |
| 16,17    | Trade open / close notices | raised from domain events published **after** the transaction commits — no path from a rejected order to a notification                                                                                                 |
| 18,19,25 | **Trade sounds**           | eight generated, distinguishable assets; a shared category→sound contract; an Android channel per sound; silence in the background so nothing doubles                                                                   |
| 23,24    | Notification centre        | in-app delivery, per-category preferences, quiet hours, unmutable security and risk categories                                                                                                                          |
| 36       | Notification admin         | `/admin/notifications`: every push delivery by outcome, error code and platform, under `notifications.read_any`; the token is not a field of the view                                                                   |
| 26       | Duplicate-event protection | `dedupeKey` at the database, `eventId` on every frame and push, a bounded `SeenEvents` on the client                                                                                                                    |
| 27       | Trading event model        | implemented as specified                                                                                                                                                                                                |
| 28       | Device / push tokens       | `Device` model, AES-256-GCM sealed tokens bound to their row, registration, revocation, provider-rejection handling                                                                                                     |
| 8        | RBAC                       | granular `resource.verb` capabilities in code, **grants as rows per tenant**, an editor cannot grant what they do not hold, and no role may credit an account and trade the credit                                      |
| 43       | Web application            | 20 routes, every one opened in a real browser by `pnpm smoke:web` — which found a sign-in race, a refusal that looked like a hang, and an orphaned permission decorator                                                 |
| 35       | **Wallets**                | money held for a person, transfers bounded by free margin rather than balance, append-only movements, manual deposits and corrections, freeze that holds rather than takes                                              |
| 15       | **Withdrawals**            | the wallet debited at the request and never shown as spendable twice, a FINANCE role that cannot make money appear beside an ADMIN that cannot let it out, identity re-checked at approval, and no invented payout rail |
| 17       | **KYC**                    | a record and sealed documents bound to their row, a review queue, decisions with a name against them, access audited per document, retention stated and enforced by trigger                                             |
| 36       | **Payments**               | a provider port, the state machine every provider's vocabulary maps onto, a real manual bank transfer, webhook plumbing that cannot credit twice, and **no invented third-party adapter**                               |
| 33       | Audit log                  | append-only enforced by a **database trigger** raising `42501` — an admin cannot edit it                                                                                                                                |
| 37       | Observability              | Prometheus metrics, `/health`, `/ready`, request-id correlation, structured logging                                                                                                                                     |
| 39       | Security                   | 40-probe pentest script, AES-256-GCM at rest, no secrets in git history                                                                                                                                                 |
| 40       | Testing                    | 1787 tests including PnL, margin, drawdown, exposure, permissions, order validation, push classification, payment idempotency, and row-level security proved by breaking it                                             |
| 41       | Security testing           | cross-tenant access, privilege escalation, token replay, rate limiting, audit tampering, invitation minting                                                                                                             |
| 44       | CI/CD                      | install → prisma → build → lint → format → typecheck → migrate → test → schema check → seed → build → smoke API → smoke WebSocket                                                                                       |

## Partial

| §   | Area        | What exists                                                                                                                                                                                       | What is missing                                                                             |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 29  | Admin panel | 13 sections at their own addresses — overview, people (+ detail, with role assignment), accounts (+ detail), instruments, risk, payments, verification, withdrawals, reconciliation, roles, audit | ~17 sections asked for. No tenants, tokens, API management, security centre.                |
| 35  | Finance     | wallets, transfers bounded by free margin, manual deposits and corrections, freeze, full audit, deposits through a provider port                                                                  | no third-party payment provider (a commercial decision, see below), no withdrawal — phase 7 |

## Does not exist — zero code

Checked by search, not by assumption.

| §   | Area                 | Status                                                                                 |
| --- | -------------------- | -------------------------------------------------------------------------------------- |
| 10  | Webhooks             | no `Webhook` model, no outbound delivery                                               |
| 6   | KYC                  | no `KYCRecord` model, nothing in `apps/api/src`                                        |
| 34  | Security Centre      | the data exists (sessions, audit, risk events); the admin section does not             |
| 38  | **AI context layer** | absent. No tool abstraction, no Redis Context Engine boundary.                         |
| —   | Wallet / payments    | no `Wallet` or `Transaction` model                                                     |
| —   | **Real market data** | `MARKET_DATA_PROVIDER` defaults to `internal-simulator`; `external` **throws on boot** |

That last row deserves emphasis. §50 says never fake functionality. The
simulator is not disguised as a real feed and the boundary refuses to pretend —
but a commercial trading platform needs a licensed feed, which is a commercial
dependency as much as an engineering one.

## The mobile app has never been run

It typechecks under the same strict configuration as everything else, it lints,
and 7 test files cover the logic that does not need a device — event
deduplication, sound decisions, the token store, protective-level patching,
chart-page escaping, number formatting.

**No screen has ever been opened.** This session had no macOS, no Xcode, no
Android SDK and no phone. Layout, navigation, whether a push actually arrives,
whether the sounds play — none of it is verified. `docs/mobile.md` says how to
build it.

Several response shapes were written from assumption and later corrected against
the services: five field names did not exist and would have rendered
`undefined`, `NaN` or `Invalid Date`. That is the class of defect a compiler
cannot catch here, and it is the reason to distrust any screen until it has been
opened.

## Documentation (§45)

Present: architecture, api, database, security, deployment, testing, websocket,
notifications, sounds, mobile, charting, risk, trading-engine, permissions
(RBAC), sessions and two-factor (auth), plus the 8 audit documents.

Added recently: `web-routes.md`, the address of every screen and why the
terminal is not inside the shell around the others; `wallet.md`, the two ledgers
and the invariant between them.

Missing: `TOKEN_MANAGEMENT` and `AI_CONTEXT` — because the features they would
describe do not exist, and §45 says do not document features that do not exist.

## Where this sits in the plan

| Phase                             | Status                                       |
| --------------------------------- | -------------------------------------------- |
| 0 — close what is open            | done                                         |
| 1 — multi-tenancy                 | done                                         |
| 2 — roles and permissions as data | done; grants are rows, per tenant            |
| 3 — web restructure               | done; 23 routes, all opened in a browser     |
| 4 — wallet and finance            | done; two ledgers, neither able to invent    |
| 5 — payments                      | done to the edge of a commercial decision    |
| 6 — KYC                           | done; manual review real, provider pending   |
| 7 — withdrawals                   | done; hold at request, FINANCE, rail pending |
| 8 — notification platform         | done; the delivery view arrived 21 September |
| 9 — API and token management      | done; keys and tokens, read-only machines    |
| 10 — outbound webhooks            | not started                                  |
| 11 — Security Centre              | not started                                  |
| 12 — mobile foundation            | done; Android builds, iOS not attempted      |
| 13 — mobile trading               | done; status shown, capture is web-only      |
| 14 — AI context layer             | not started                                  |
| 15 — real market data             | not started, plus a commercial dependency    |

**12 of 16** of the earlier plan. The specification was then replaced
([architecture-audit.md](./architecture-audit.md)); progress against the new
plan's phases is below and in [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## New plan, Phase 1 — domain and multi-tenant foundation

`Tenant.kind` (PLATFORM | BROKER) with a broker profile (`legalName`,
`defaultExecutionMode`); the oldest tenant is the platform. Eight new roles in
three groups, seeded by tenant kind and reconciled into existing tenants at
boot; the specification's role names map onto the existing keys. Who may put
someone into a role is one rule in `RolesService.assertAssignable` — a role the
tenant has, not above the assigner's group, and not widened beyond the assigner
— used by role assignment and by role-granting invitations alike. The platform
creates brokers (`/admin/brokers`) and hands back the owner's invitation once;
a broker cannot reach that, by capability and by tenant kind. The
first-administrator CLI takes `--role PLATFORM_SUPER_ADMIN`.

Envelope v2 on every domain event: `version`, `aggregateType`, `aggregateId`,
`actorId`, `correlationId`, `causationId`, filled from a request-scoped store
the middleware opens and the guard fills — additive, no consumer changed.

`SecurityEvent`: a projection of the audit log written by `AuditService`
itself, append-only, tenant-scoped; a person reads their own on `/security`, the
firm reads everyone's on `/admin/security`. Account statuses `PENDING` and
`LOCKED`, and one policy table (`ACCOUNT_STATUS_POLICY`) that decides open,
modify and close for every status — the holder of a locked account does
nothing, the engine's stops still fire. Order-path ceilings per account and per
tenant in Redis, allow-and-log when Redis is away.

Fifty-nine new tests across brokers, registration, administration, the CLI,
security events, the envelope, the throttle and the status policy; seven
mutations caught. Smoke 19 checks (the security feed over HTTP; the boot
failure on a `Date` in a DTO schema was caught here and nowhere else), web smoke
81 checks over 26 routes (the feed on `/security`, the broker created from
`/admin/brokers`), pentest 44 attacks refused (running the platform from a
broker with an escalated role; reading another person's feed). See
[brokers.md](./brokers.md) and [security-events.md](./security-events.md).

## New plan, Phase 2 — broker connection and adapter SDK

`@tp/broker-sdk`, framework-free: the `BrokerAdapter` port; capability
discovery (a connector says what the venue does, and an unsupported order type
is refused before it is sent); `UNKNOWN` as a first-class order outcome with
`queryOrder` as the recovery, so a timeout is never resent and never read as a
breach; `ConnectionMonitor` — the seven-state machine with a doubling breaker
that opens at once and for the cap on AUTH_FAILED and honours a venue's own
retry-after; `MockBrokerAdapter`, which keeps real state and misbehaves on
request across the whole §41/§67 catalogue including duplicate and
out-of-order events; `brokerAdapterContract`, the suite any connector must
pass; the credential envelope (seal, fingerprint, metadata, redaction); and a
registry that **refuses to register a venue connector that names no
documentation**.

On the platform: `BrokerConnection` and `BrokerCredential` — RLS, a trigger
that fixes what was sealed, a trigger that refuses deletion — the
`/admin/broker-connections` routes (session-only; `broker_connections.manage`
is person-only), the Connections screen, and the worker's per-minute health
sweep that skips a connection whose breaker is open and reports a missing
key, an unopenable blob and a missing connector each as a state on that
connection rather than as a crash.

**Still blocked:** a connector to a real venue needs that venue's API
documentation and sandbox. Reported, not stubbed — see
[broker-integration.md](./broker-integration.md).

Fifty-seven new tests; six mutations caught. The seventh survived and found a
real defect: **a nested Prisma `include` is not narrowed by the tenancy
extension**, so a credential row misfiled under another firm was visible
through its connection. Both services now name the tenant on the relation and
[multi-tenancy.md](./multi-tenancy.md) §6 records the rule. Smoke 20, web smoke
84 over 27 routes, pentest 45.

## New plan, Phase 3 — broker accounts, external execution, outbox and inbox

`Account.executionMode` decides where an order goes, and a database CHECK
makes the meaningless combination impossible: an external account always
carries a connection and an identity at the venue, and one venue account
belongs to one platform account. `OrdersService` gains exactly one branch, and
only after every refusal it already made — an external account is a different
destination for a legal order, not a way around the rules.

`ExternalExecutionService` writes the order row, with the `clientOrderId` it
is about to send, **before** the request leaves. That ordering is the whole
recovery story: a crash after sending leaves a row and a handle to ask about,
where sending first would leave a position at a venue this platform cannot
name. `OrderStatus.UNCONFIRMED` is what it records when the answer does not
come back — including when the call threw, because a dropped connection is a
fact about the connection and never about a trade. The state machine lets an
order leave UNCONFIRMED only for a definite end, never back to ACCEPTED.

`VenueRecoveryService` (in the API, beside the one definition of what a
venue's answer does to these rows) asks each venue with the id that was sent,
after a grace period, because the original request may still be in flight. It
asks; it never resends. "The venue has no record of it" cancels the order —
placing it again at today's price is the trader's decision, and a resend is
how one intent becomes two positions. A venue that cannot be reached produces
no decision at all. `/admin/venue-recovery` shows what is waiting and offers
one verb: ask again.

`BrokerInstrumentMapping` is explicit and audited. An unmapped instrument
cannot be traded on that connection and the refusal names what is missing;
suggestions stop at the first ambiguity; the venue's own lot terms are copied
at map and re-read by a sync that **reports** what moved — including an
instrument the venue has stopped listing — and repairs nothing.

`OutboxEvent` is written in the same transaction as the change it describes
and carries the id the socket frame carries, so one occurrence is never
counted twice. The worker's relay keeps a failure rather than dropping it:
attempts counted, backoff held in the row so a restart cannot lose it, and
ABANDONED — not deleted — after the cap. `BrokerInboundEvent` records what a
venue sent before it is acted on: unique per `(connection, external id)` so a
redelivery is never a second fill, ordered by the venue's own sequence,
immutable and undeletable, with only the handling status moving and a replay
for what corrected code should re-apply.

Forty-five new tests. Eleven mutations run, nine caught outright; two survived
and both were real gaps in the tests rather than in the code — that the outbox
row is written _inside_ the fill's transaction, and that a credential misfiled
under another firm is not shown on its own connection. Both now have tests
that fail when the guarantee is removed. `pnpm verify` green: 1955 tests.
[external-execution.md](./external-execution.md).

**Still blocked:** the connector to a real venue. Everything above is proved
against `MockBrokerAdapter`.

## New plan, Phase 4 — desks, delegation presets, and the risk hierarchy

Four delegation presets — viewer, trader, manager, owner — that **expand at
grant time** into the capabilities stored on the link. A role is a live
reference and a delegation must not be one: "Hossein may trade this account" is
a decision made about one person on one day, and widening `MASTER_TRADER` next
quarter must not silently widen every delegation granted under that name. The
name is kept beside the list for the screen and the audit row; the list is what
is enforced, and a link edited afterwards stops claiming to be the preset it
started as. `MASTER_OWNER` and `MASTER_MANAGER` presently expand to the same ten
capabilities because the linkable ceiling is exactly the manager set — said in
the code and asserted by a test, so the day they diverge is a day someone looks.

`DeskViewService` is what a desk adds up to: every account it may **read**, its
exposure netted by symbol, and the totals. A link granting `orders.create` is a
delegation to trade, not a licence to read a balance, so such an account is not
in the book. Equity comes from `AccountStateService` rather than being
recomputed, so a desk total and an account's own screen cannot disagree. An
account that cannot be converted into the desk's currency is **named**, and no
total is printed at all — a total that quietly dropped it would read as a
smaller book than the desk actually runs.

`RiskLimitSet` gives the hierarchy platform → broker → desk → account. Each
layer may tighten what is above it and none may loosen it, enforced twice on
purpose: a looser value is **refused when written**, naming the layer and what
it allows, because an administrator told their ceiling was saved will believe
it; and the resolver takes the tightest value across every layer **when read**,
so a row that arrived by a restored backup still cannot widen anything.
Comparisons are numeric, never lexical. A null layer is silence, not permission.

The desk layer binds the **route**, not the account: a ceiling on a desk binds
orders its operators place and does not bind the account holder, who never
agreed to it. `Order.placedByMasterAccountId` carries that provenance so a
resting order fills under the ceiling that governed its placement — without it
an operator under a two-position cap could place five pending orders and have
all five fill. The database keeps one limit set per layer by partial unique
index, and refuses a row claiming to be a firm ceiling while naming one desk.

Margin-call and stop-out levels are deliberately **not** in the hierarchy:
"stricter" runs the other way for them, and minimising them would give every
account the loosest stop-out on the platform. Stated rather than got backwards.

Fifty-one new tests. Ten mutations run, ten caught. Screens: Desks in the admin
console, a Ceilings tab on the Risk console. The desk view in the _terminal_ is
left to Phase 6, where the terminal is being rebuilt anyway.

`pnpm verify` 1998 tests over 149 files; smoke 20; web smoke 100 over 29 routes;
pentest 47 attacks refused.
[desks-and-risk-hierarchy.md](./desks-and-risk-hierarchy.md).

## New plan, Phase 5 — the broker panel

Three things a firm could not do, and a plain list of what still cannot be
done.

**The firm's own book.** Every trading listing on this platform is
account-scoped and ownership-checked — right for a trader, useless for the
person running the firm, who had to answer "what is open across the book" and
"why was that order rejected at 14:32" from a database console. `/admin/book`
is orders, positions and closed trades across the tenant, each row carrying the
account number and the owner, with an order's own events one click away. It
takes `accounts.read_any` and deliberately not `orders.read`, which every
trader holds; the pentest attacks exactly that. Paging is keyset with the row
id in the cursor, because a book is read while orders are arriving and several
share a millisecond — offset paging would repeat some rows and drop others, and
a dropped row is the one somebody is looking for. An unknown account number
matches nothing rather than everything. Export is of the page and says so.

**The trading week.** `MarketSession` had existed since the beginning with no
writer but the seed, so a firm needing Friday to close an hour early needed a
database console. It is editable on the Instruments screen now, and the rules
are the interesting part: the week is replaced **whole** (a half-saved week is
a market open when it should be shut), overlapping windows are refused rather
than merged (a union hides which of two disagreeing descriptions was meant), a
window may not cross midnight and the refusal says how to express one that
does, the timezone is checked against the system's own tz database, it is a
platform act because sessions are when the _venue_ trades, and the engine's
cached copy is refreshed on save so the change does not wait for a restart.

**Money on the dashboard.** It was counts only: how many orders were rejected
last hour, and nothing about what the firm held or earned. Now balance,
deposits, withdrawals, commission, swap, traders' net P&L, closed trades and
volume — **by currency, never summed across them**, because one number made by
adding dollars to euros looks authoritative and reconciles with nothing.

Forty-eight new tests. Eight mutations run, seven caught outright; the survivor
was a real gap — nothing tested the case the cursor's id half exists for, so a
test now pages through six orders sharing one timestamp and fails without it.

**Not built, named rather than stubbed:** Fees as a section, Reports,
Alerts, admin device management, IP rules, Branding, outbound webhooks, and API
documentation in production. Each is listed in
[broker-panel.md](./broker-panel.md) with where it belongs.

`pnpm verify` 2029 tests over 152 files; smoke 20; smoke:worker 3; web smoke
107 over 30 routes; pentest 48 attacks refused.

## New plan, Phase 6 — the terminal, where it was wrong rather than plain

Four defects, and a written account of the presentation work not done.

**One calculator, shared.** A stop can be expressed as a price, a distance, a
number of points or the money it would cost, and a trader moves between them
freely. That arithmetic lived in three places in the web app and a fourth on
the phone — four chances to disagree about a number visible in two places at
once. `@tp/trading-core/levels.ts` is the one implementation now, framework-free
and on decimal arithmetic, with three rules: direction is derived from the
position's side and the level's kind rather than asked for (a caller that works
it out is a caller that can get it wrong); no exchange rate is ever assumed, so
a browser without one gets `null` rather than a confident wrong number; and
sizing from a risk rounds **down** to the volume step, because a size that
rounded up would risk more than was asked for.

**Close-all is a server command.** It was a loop in the browser: one request
per position, partial failure swallowed, and no record anywhere that "close
everything" had been asked for. `POST /positions/close-all` states the intent
once and reports each position. It is deliberately **not atomic** and its
result says so — one transaction would hold the account lock throughout,
deadlock against the tick loop closing a stop, and let one unpriceable
instrument roll back closes that already happened at real prices. Largest
margin first, so an account near a stop-out releases the most margin soonest.

**Risk as a share of equity** in the ticket, because "two percent" is a rule
people follow and "eighty-four dollars" is not. **Large-order confirmation**
measured against the account — half of free margin, or a tenth of equity at the
stop — forced even in one-click mode, since one-click was a convenience for
ordinary size and never a request to skip the order that could take the account
down. **An account selector**: the terminal set `accounts[0]` at sign-in and
never exposed a way to change it, so a trader with two accounts could reach
only the first; the remembered choice is validated against the account list on
every sign-in.

Thirty-two new tests. Six mutations run, five caught; the sixth is an equivalent
mutant — removing the explicit null-rate guard leaves the exception path
returning the same `null`, verified directly rather than assumed, and the guard
stays as defence against `grossPnl` ever coercing a null.

**Not delivered, and named:** the watchlist's inline quick ticket, categories
and top movers; stop-limit orders (an engine change, not a form control);
trailing and expiry at entry; estimated swap; Finance/Alerts/Logs tabs;
multi-select "Close (n)"; the edit dialog's other entry modes; spacing and
typography scales; a light theme; a documented accessibility pass.
[uiux.md](./uiux.md) gives the reason for each. What was built is where the
alternative was a defect; the rest is presentation, and presentation without
the screenshots it is meant to match would be invention.

`pnpm verify` 2062 tests over 154 files; pentest 49 attacks refused.

## New plan, Phase 7 — chart persistence (the rest blocked)

Chart state was client-local: a reload lost the resolution, and nothing a
trader arranged survived closing the tab. `ChartLayout`, `ChartTemplate` and
`UserDrawing` hold it now, per user and per account, with RLS.

The shape is the argument. `content` is a blob this platform **never parses** —
a chart's arrangement is the renderer's own description of itself, and this
platform is going to change renderer when the licensed library arrives. Parsing
it would mean holding an opinion about a format we do not own and being wrong
the first time it moves. Columns carry only what can be answered without
parsing — whose layout, which instrument, which resolution, which to open — and
that is exactly the part that survives the swap: a layout the new library
cannot read still says what it was of. Size is capped at 256 KB, with a refusal
naming both the size given and the limit.

Three tables because the three things have different lifetimes: a layout is one
arrangement of one instrument and belongs to an account, since the levels on it
are that account's positions; a template is a set of studies with no instrument
at all; and **drawings belong to the instrument**, because a trendline drawn on
gold is about gold and a trader who switches layout expects their lines to
still be there. Folding drawings into a layout would silently lose them.

One default per person per account, enforced by a partial unique index — two
indexes, because `account_id` is nullable and Postgres treats NULLs as
distinct. Setting a new default clears the old one in the same transaction.
Someone who has saved nothing gets `null`, never an invented default.

The web app persists and restores the instrument and resolution, debounced by
two seconds, and arms the save only after the restore has run — saving first
would overwrite the layout on every page load, which is the failure that turns
"remembered" into "reset".

Sixteen new tests. Four mutations run, four caught. The tenancy scope list was
missing the three new models, and the cross-firm test caught it.

**BLOCKED:** indicators, the drawing set and bid/ask axis labels are what the
TradingView Advanced Charts licence is _for_. Building them on
`lightweight-charts` primitives would be writing a second charting library and
throwing it away when the licence arrives. P&L on the SL/TP labels already
shipped with the existing drag work.

`pnpm verify` 2078 tests over 155 files; pentest 50 attacks refused.

## Phase 9 — API keys and service tokens

`ApiKey` and `ServiceToken`, tenant-scoped, with per-credential permissions,
an expiry, revocation, a per-credential rate limit and a daily usage counter.
The specification's rule holds without exception: the secret is 32 random
bytes shown once, its SHA-256 is what is stored, and `tpk_<handle>` is the
fingerprint every list and audit row shows. A key acts as its holder within a
subset of their capabilities fixed at minting and intersected with their
current role on every use; `PERSON_ONLY_PERMISSIONS` names what a key may
never carry and why. A service token belongs to the firm and carries reads
across the tenant and nothing else — the audit log has no way yet to name a
machine that wrote, and that gap is stated rather than filled. Credentials
reach only routes that name a capability, never a self-service or session-only
one, and never the WebSocket. Minting asks for the password again.

Screens: API keys on `/security`; everyone's keys and the firm's tokens on
`/admin/credentials`. Twenty integration tests, fifteen guard tests, nine on
the credential format, five mutations caught; the smoke suite mints and uses a
key over HTTP; two pentest probes try to do more with a stolen key than it was
minted for. See [api-keys.md](./api-keys.md).

## Phase 7's deploy, and the three things it found

The withdrawals migration applied cleanly, the boot reconcile created the
FINANCE role with its nine grants, and ADMIN gained `roles.assign`. Then the
check that was meant to be a formality — which administrator will put somebody
into FINANCE? — found that production has **no administrator**: twenty-five
registered users, every one of them `USER`, since the first deploy. Nothing
creates one, correctly; nothing documented how the first one comes to exist.
`scripts/first-administrator.sh` now does — the compiled CLI inside the migrate
image, doing what `POST /admin/users/:id/role` does minus the actor it cannot
have, refusing once an administrator exists. See
[deployment.md](./deployment.md#the-first-administrator).

The worker's log then showed **reconciliation had never run** since tenancy
went live: five refused attempts an hour, because the run row was written in
no scope. The harness had hidden it by entering a tenant in `beforeEach`.
`@tp/tenancy` gained `outsideAnyScope`, every job the registry attaches is now
driven from there, and three of those tests fail against the old service. See
[multi-tenancy.md](./multi-tenancy.md).

The first run after that reported, within the hour, a real discrepancy: the
ledger held exactly **twice the swap** the trades reported on one account.
Closing a position had posted its accrued swap to the ledger a second time, the
worker having settled it the night it accrued. Every test had closed positions
the day they opened; two now hold one overnight. See
[pnl.md](./pnl.md#swap-is-settled-the-night-it-accrues-and-reported-at-close)
and [reconciliation.md](./reconciliation.md). The finding stays open and the
balance stays as found, for a person to correct with a reason — which is the
reconciliation engine's rule, applied to the first thing it caught.

Three defects, none of them visible to 1,720 passing tests, all three found by
looking at what the deploy actually did. The smoke suite and the production log
after every deploy are not optional.

## Phase 6 — and the ten minutes the API was down

Identity verification is done to the same edge as payments: the manual path
is real, the provider port exists, the adapter is a commercial decision. See
`docs/kyc.md`.

Deploying it took production down for about ten minutes — 21:37 to 21:47 UTC
on 1 September — and the cause is worth recording because nothing in 1,664
tests could have seen it. `kyc.module.ts` imports `raw` from `express` for the
document route. On a developer's machine that resolves through hoisting; in the
image, pnpm's strict layout gives `apps/api` only what its own `package.json`
declares, and `express` was a transitive dependency of `@nestjs/platform-express`.
The API crash-looped on `Cannot find module 'express'` with the web container
healthy and the migration applied.

Two guards came out of it. `scripts/declared-dependencies.test.ts` requires every
bare import in an application to be declared by that application — verified by
removing `express` and watching it name the three files. And the upgrade script
now recreates nginx when its bind-mounted configuration changed between the two
commits, because a file bind mount is a mount of an inode: the container that
was "Up 34 hours" had never seen the raised body limit, and refused a 3 MB
upload at the edge with every test green.

## The payment provider is a decision, not a task

Phase 5 is done up to the point where engineering stops and a contract starts.

What exists: the `PaymentProvider` port, the state machine every provider's
vocabulary is mapped onto, the webhook endpoint with raw-body signatures
available to whoever implements one, the event log, two independent idempotency
mechanisms, the wallet credit, the operator queue, and a **real** manual bank
transfer — which is how most firms take their first deposits and many take their
largest.

What does not exist, deliberately: an adapter for a third-party processor.
Choosing one is a commercial decision — pricing, settlement, which countries,
who signs — and an adapter written against public documentation for a contract
nobody has signed would be an integration that has never taken a payment,
sitting in the repository looking finished. §45 and the plan both say not to
build UI for functionality that does not exist; the same applies to the
integration behind it.

Adding one means implementing that interface and registering it. See
`docs/payments.md`.

### The worst thing this phase found was not in the payments code

Deploying it put a fresh pair of eyes on the production logs, and they were full:
**12,296 failures on the ingest instance**, from paths nobody had looked at since
tenant isolation went live.

The guard refuses a query made with no tenant in scope. A request always has one.
A _timer_ does not — and neither does a tick handler or a socket refresh. So the
platform served every request perfectly while stop-losses did not fire, stop-outs
did not liquidate, realtime valuations never reached a terminal, no snapshots were
taken, and `refreshSockets` — the thing that takes revoked account access _off_ a
live socket — failed before it could take anything.

Nothing in 1,600 tests noticed, because every test that touches those services
drives them from inside a scope the harness already entered.

All six are fixed with one shape: discovery crosses tenants and says so with a
reason; the work itself is re-entered inside each row's own tenant. And
`background-scope.test.ts` now sweeps the source for anything that starts
background work and touches the database without naming a tenant — a static
check, because a behavioural one would have to be _given_ the list of background
services, and the ones worth catching are exactly the ones nobody adds to such a
list. See [multi-tenancy.md](./multi-tenancy.md) §6a.

### Two things this phase found in the payments path

**A capability added to a constant never reached a running platform.** Grants
became rows in Phase 2 so a firm could change them without a deployment; the
reverse case had no owner. `seedTenantRoles` knew how to close the gap and only
the database seed ever called it, so a deployment upgraded through
`prisma migrate deploy` got the new endpoints and none of the permission to
reach them — 403 for everybody, having passed every test. The API now reconciles
untouched built-in roles with the build at boot. Roles anybody has edited are
left exactly as they were left.

**`WalletService.ensure` and the idempotency check inside `post` were both
read-then-write.** Two things asking for the same wallet at the same moment —
a webhook crediting a deposit while the person has the wallet page open is
enough — and the loser got a unique-constraint violation thrown at it. In the
payment path that surfaced as a _payment_ that failed. Both are fixed, and the
fix for the second is an ordering: take the wallet's row lock **before** reading
the idempotency key, so a concurrent caller waits and then sees the movement
rather than colliding with it.

## Tenant isolation now bites — once one line is set in production

Row-level security had been installed and disarmed, and the migration that
installed it said so honestly: PostgreSQL exempts a table's owner from its own
policies, the application owns its tables, so the second layer protected an
analyst's psql session and not the application.

It now protects the application too. Tenant traffic runs on a second database
role that owns nothing, and the tenant rides on the connection's startup options
rather than on a transaction, which measured _faster_ than having no policies at
all — 0.54ms p50 against a 0.72ms floor, where the transaction approach cost
1.85ms. Eight integration tests prove it from that role, including the two
things the Prisma extension explicitly cannot close: a raw cross-tenant read and
a nested `connect`. Each was verified by breaking row-level security four
different ways and confirming the tests failed.

**Live on https://devopss.ir since 2026-09-01.** `scripts/upgrade-server.sh`
creates the role, verifies it, and writes `DATABASE_URL_TENANT` — in that order,
because the API refuses to boot if the variable is set and the role turns out to
be exempt. The deployment's own log now reads:

```
trading_app reads 0 of 25 users with no tenant set; DATABASE_URL_TENANT written
PrismaService: Database connection established; tenant isolation enforced at the database
```

Note what made the second role necessary rather than optional: on that host the
application's role is a _superuser_, and a superuser bypasses row-level security
whether or not the policies are FORCE'd. Ownership was not the only exemption in
play.

## What the Definition of Done still needs

**Backend**: builds ✅ tests ✅ APIs ✅ auth ✅ RBAC ✅ tenant isolation ✅
trading ✅ risk ✅ WebSocket ✅ notifications ✅ audit ✅

**Admin**: dashboard ✅ users ✅ accounts ✅ trading ✅ risk ✅ permissions ✅
tokens ❌ API management ❌ notification management ❌ audit ✅ security centre ❌

**Mobile**: Android builds ✅ (signed APK, verified) iOS builds ❌ (needs macOS) authentication ✅ dashboard ✅ market data ✅ charts ✅ order placement ✅
position management ✅ history ✅ notifications ✅ push ✅ sounds ✅ notification
settings ✅ — **all verified by compiler and unit test only, never on a device.**

**Security**: no critical vulnerabilities ✅ no secrets committed ✅ no
cross-tenant access ✅ (both layers: the application scope, and row-level
security enforced against the application itself, live on devopss.ir)
no frontend-only authorization ✅ sensitive actions audited ✅ tokens protected ✅

Every link of the chain the prompt draws exists in code: user → app → API → auth
→ RBAC → risk engine → trading engine → execution → database → event → WebSocket
→ notification service → in-app notice, push, and the right sound.

What has not happened is anyone walking that chain on a phone.

## Phase 8 — realtime and notification hardening

Four things, and one deliberate gap.

**Leadership.** The trigger engine and market ingest had to run in exactly one
process, and what arranged that was `TRIGGER_ENGINE_ENABLED=true` on one
container — a convention held up by whoever last edited the compose file. A
rolling deploy overlaps old and new for as long as the old one takes to drain;
`--scale api-ingest=2` typed once does it permanently. Two engines on one tick
is one position stopped out twice and one resting order filled twice, because
both read `OPEN` before either wrote.

A lease in `leader_leases` now decides it, from the database's clock, so
contenders are never compared against each other's. The flag means "may
contend". The market feed relays from its first second and switches to ingesting
when it wins, so a container coming up during a deploy serves correct prices
while it waits rather than stale ones.

What a lease cannot do is written down in the service: a stalled leader can wake
past its expiry believing it still leads. Three things narrow the window — a
renewal at a third of the TTL, a local deadline the holder refuses to act past
without asking the database, and loss delivered to the loop — and none closes
it. Which is why the writes underneath stay conditional on the row's state
inside their own transaction. Leadership reduces contention; it is not what
makes those writes safe.

The worker's scheduled jobs needed nothing: BullMQ's job scheduler already
produces one job per cron tick however many replicas run. That was checked
rather than assumed, and then left alone.

**Latency.** Six histograms, all measured from the tick's own timestamp rather
than from the start of the stage reporting them, plus a four-stage order
timeline. Queue lag is the gap: it is recorded in the worker's job log but has
no Prometheus surface, because the worker serves no HTTP. Saying so is better
than inventing an endpoint nobody scrapes.

**Price alerts.** End to end, and kept away from pending orders everywhere —
different table, different tab, different sound. They look alike on screen and a
pending order _does_ something when the price gets there.

**Haptics.** Decided beside the sound, never from it.

### What the gate found that the tests did not

Three defects, none of which 2,144 passing tests could have caught:

1. **`z.coerce.date()` in a DTO took the API down at boot.** The OpenAPI
   document is generated from the Zod schemas, and a `Date` has no JSON Schema
   representation, so the process threw before it listened. Found by `pnpm
smoke`, which spawns its own API — the same guard that caught this once
   before, and the reason it exists.
2. **The web smoke's market-opening helper asked the wrong question.** It
   checked "is there a session today", which gold satisfies on a Sunday from
   22:00, and then placed an order at half past four in the afternoon. "There is
   a session today" and "the market is open" are different questions.
3. **A flaky assertion in the APNs test.** It asserted the signature's first
   byte was not DER's `0x30` tag. That byte is the top of `r`, which is random,
   so it failed one run in 256 — while carrying nothing, since the length check
   beside it already excludes DER and the verification below it proves the
   encoding positively. A flaky test in the gate is worse than no test: it
   teaches people to re-run rather than to look.

A fourth thing the gate found was not a defect: a hard-killed leader leaves its
lease to lapse, and for up to ten seconds nothing ingests prices. An order in
that window is refused `STALE_QUOTE`, which is the platform correctly declining
to fill on a price it knows is old. That is the cost of the lease, and the
alternative is not "no window" but "two engines during the window".
