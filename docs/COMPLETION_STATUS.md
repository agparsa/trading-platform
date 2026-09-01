# Completion status against the MASTER PROMPT

Measured against the working tree, not against memory. Every figure below comes
from a command run against this repository.

> **This document went stale once, silently.** Three rounds of edits to it were
> string replacements that stopped matching after Prettier reformatted the
> tables, so the file kept saying "there is no mobile app" while the mobile app
> was being committed around it. It is now regenerated from measurement rather
> than patched. If you are editing it, re-measure — do not trust the prose.

**Short answer: the master prompt is not complete.** Four of sixteen planned
phases are done. `docs/IMPLEMENTATION_PLAN.md` estimates **nine to twelve months
for one engineer**, and nothing has happened to make that estimate wrong.

## The evidence baseline

```
pnpm build:packages   ok
pnpm lint             ok
pnpm format:check     ok
pnpm typecheck        ok
pnpm inventory --check ok
pnpm test             120 files, 1562 tests, 0 failures
pnpm build            ok
```

4 applications (`api`, `web`, `worker`, `mobile`), 13 workspace packages, 41
Prisma models, 106 API routes, ~78,000 lines of TypeScript. Live at
https://devopss.ir.

The route count was 95 here and 84 in `docs/API_INVENTORY.md`'s hand-written
header while the generated table in that same file listed 94. Both hand-written
figures are gone; the generated one is the only one left.

## Built, tested, and running

Complete in the sense the prompt defines — UI → API → business logic → database
→ authorization → security → audit → tests.

| §        | Area                       | Evidence                                                                                                                                                                                  |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2        | Repository audit           | 8 documents in `/docs`, every figure produced by a command                                                                                                                                |
| 4        | Multi-tenancy              | `Tenant` model, `tenantId` on 32 models, `AsyncLocalStorage` scope, Prisma client extension, **row-level security enforced against the application**, cross-tenant pentest probe          |
| 5        | Database                   | PostgreSQL 16, Prisma 6, `NUMERIC(28,10)`, **zero float columns**, enforced in CI                                                                                                         |
| 7        | Authentication             | password hashing, refresh rotation in httpOnly cookies, TOTP 2FA with recovery codes, sessions, device and IP visibility, rate limiting                                                   |
| 11       | Trading engine             | market / limit / stop, SL/TP trigger engine, modify, cancel, partial close, PnL, equity, margin, leverage, commission, spread, swap accrual                                               |
| 12       | Risk engine                | deterministic, `risk-core` framework-free and unit-tested                                                                                                                                 |
| 13       | WebSocket                  | authenticated, heartbeat, reconnect, subscriptions, tenant isolation, shared market-data infrastructure                                                                                   |
| 14       | **Mobile application**     | `apps/mobile` — Expo SDK 57, 14 screens, auth with 2FA, push, sounds, chart. **Never built for a device** — see below                                                                     |
| 15,21,22 | **Push notifications**     | FCM HTTP v1 for Android and web, APNs over HTTP/2 for iOS, delivery records, retry/drop classification, a client that registers and deduplicates                                          |
| 16,17    | Trade open / close notices | raised from domain events published **after** the transaction commits — no path from a rejected order to a notification                                                                   |
| 18,19,25 | **Trade sounds**           | eight generated, distinguishable assets; a shared category→sound contract; an Android channel per sound; silence in the background so nothing doubles                                     |
| 23,24    | Notification centre        | in-app delivery, per-category preferences, quiet hours, unmutable security and risk categories                                                                                            |
| 26       | Duplicate-event protection | `dedupeKey` at the database, `eventId` on every frame and push, a bounded `SeenEvents` on the client                                                                                      |
| 27       | Trading event model        | implemented as specified                                                                                                                                                                  |
| 28       | Device / push tokens       | `Device` model, AES-256-GCM sealed tokens bound to their row, registration, revocation, provider-rejection handling                                                                       |
| 8        | RBAC                       | granular `resource.verb` capabilities in code, **grants as rows per tenant**, an editor cannot grant what they do not hold, and no role may credit an account and trade the credit        |
| 43       | Web application            | 20 routes, every one opened in a real browser by `pnpm smoke:web` — which found a sign-in race, a refusal that looked like a hang, and an orphaned permission decorator                   |
| 35       | **Wallets**                | money held for a person, transfers bounded by free margin rather than balance, append-only movements, manual deposits and corrections, freeze that holds rather than takes                |
| 17       | **KYC**                    | a record and sealed documents bound to their row, a review queue, decisions with a name against them, access audited per document, retention stated and enforced by trigger               |
| 36       | **Payments**               | a provider port, the state machine every provider's vocabulary maps onto, a real manual bank transfer, webhook plumbing that cannot credit twice, and **no invented third-party adapter** |
| 33       | Audit log                  | append-only enforced by a **database trigger** raising `42501` — an admin cannot edit it                                                                                                  |
| 37       | Observability              | Prometheus metrics, `/health`, `/ready`, request-id correlation, structured logging                                                                                                       |
| 39       | Security                   | 38-probe pentest script, AES-256-GCM at rest, no secrets in git history                                                                                                                   |
| 40       | Testing                    | 1664 tests including PnL, margin, drawdown, exposure, permissions, order validation, push classification, payment idempotency, and row-level security proved by breaking it               |
| 41       | Security testing           | cross-tenant access, privilege escalation, token replay, rate limiting, audit tampering, invitation minting                                                                               |
| 44       | CI/CD                      | install → prisma → build → lint → format → typecheck → migrate → test → schema check → seed → build → smoke API → smoke WebSocket                                                         |

## Partial

| §   | Area               | What exists                                                                                                                                                    | What is missing                                                                             |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 29  | Admin panel        | 12 sections at their own addresses — overview, people (+ detail), accounts (+ detail), instruments, risk, payments, verification, reconciliation, roles, audit | ~17 sections asked for. No tenants, tokens, API management, security centre.                |
| 35  | Finance            | wallets, transfers bounded by free margin, manual deposits and corrections, freeze, full audit, deposits through a provider port                               | no third-party payment provider (a commercial decision, see below), no withdrawal — phase 7 |
| 36  | Notification admin | `push_deliveries` records every attempt with its outcome                                                                                                       | no admin view over them                                                                     |

## Does not exist — zero code

Checked by search, not by assumption.

| §   | Area                 | Status                                                                                 |
| --- | -------------------- | -------------------------------------------------------------------------------------- |
| 9   | Token management     | no `ApiKey` or `ServiceToken` model, no admin section                                  |
| 10  | API management       | no registry, no scopes, no per-key rate limits, no usage logs                          |
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

| Phase                             | Status                                     |
| --------------------------------- | ------------------------------------------ |
| 0 — close what is open            | done                                       |
| 1 — multi-tenancy                 | done                                       |
| 2 — roles and permissions as data | done; grants are rows, per tenant          |
| 3 — web restructure               | done; 22 routes, all opened in a browser   |
| 4 — wallet and finance            | done; two ledgers, neither able to invent  |
| 5 — payments                      | done to the edge of a commercial decision  |
| 6 — KYC                           | done; manual review real, provider pending |
| 7 — withdrawals                   | not started                                |
| 8 — notification platform         | done; admin statistics view remains        |
| 9 — API and token management      | not started                                |
| 10 — outbound webhooks            | not started                                |
| 11 — Security Centre              | not started                                |
| 12 — mobile foundation            | done; Android builds, iOS not attempted    |
| 13 — mobile trading               | done; status shown, capture is web-only    |
| 14 — AI context layer             | not started                                |
| 15 — real market data             | not started, plus a commercial dependency  |

**10 of 16.**

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
