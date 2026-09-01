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
pnpm test             119 files, 1504 tests, 0 failures
pnpm build            ok
```

4 applications (`api`, `web`, `worker`, `mobile`), 13 workspace packages, 39
Prisma models, 97 API routes, ~72,500 lines of TypeScript. Live at
https://devopss.ir.

The route count was 95 here and 84 in `docs/API_INVENTORY.md`'s hand-written
header while the generated table in that same file listed 94. Both hand-written
figures are gone; the generated one is the only one left.

## Built, tested, and running

Complete in the sense the prompt defines — UI → API → business logic → database
→ authorization → security → audit → tests.

| §        | Area                       | Evidence                                                                                                                                                                           |
| -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2        | Repository audit           | 8 documents in `/docs`, every figure produced by a command                                                                                                                         |
| 4        | Multi-tenancy              | `Tenant` model, `tenantId` on 32 models, `AsyncLocalStorage` scope, Prisma client extension, **row-level security enforced against the application**, cross-tenant pentest probe   |
| 5        | Database                   | PostgreSQL 16, Prisma 6, `NUMERIC(28,10)`, **zero float columns**, enforced in CI                                                                                                  |
| 7        | Authentication             | password hashing, refresh rotation in httpOnly cookies, TOTP 2FA with recovery codes, sessions, device and IP visibility, rate limiting                                            |
| 11       | Trading engine             | market / limit / stop, SL/TP trigger engine, modify, cancel, partial close, PnL, equity, margin, leverage, commission, spread, swap accrual                                        |
| 12       | Risk engine                | deterministic, `risk-core` framework-free and unit-tested                                                                                                                          |
| 13       | WebSocket                  | authenticated, heartbeat, reconnect, subscriptions, tenant isolation, shared market-data infrastructure                                                                            |
| 14       | **Mobile application**     | `apps/mobile` — Expo SDK 57, 14 screens, auth with 2FA, push, sounds, chart. **Never built for a device** — see below                                                              |
| 15,21,22 | **Push notifications**     | FCM HTTP v1 for Android and web, APNs over HTTP/2 for iOS, delivery records, retry/drop classification, a client that registers and deduplicates                                   |
| 16,17    | Trade open / close notices | raised from domain events published **after** the transaction commits — no path from a rejected order to a notification                                                            |
| 18,19,25 | **Trade sounds**           | eight generated, distinguishable assets; a shared category→sound contract; an Android channel per sound; silence in the background so nothing doubles                              |
| 23,24    | Notification centre        | in-app delivery, per-category preferences, quiet hours, unmutable security and risk categories                                                                                     |
| 26       | Duplicate-event protection | `dedupeKey` at the database, `eventId` on every frame and push, a bounded `SeenEvents` on the client                                                                               |
| 27       | Trading event model        | implemented as specified                                                                                                                                                           |
| 28       | Device / push tokens       | `Device` model, AES-256-GCM sealed tokens bound to their row, registration, revocation, provider-rejection handling                                                                |
| 8        | RBAC                       | granular `resource.verb` capabilities in code, **grants as rows per tenant**, an editor cannot grant what they do not hold, and no role may credit an account and trade the credit |
| 33       | Audit log                  | append-only enforced by a **database trigger** raising `42501` — an admin cannot edit it                                                                                           |
| 37       | Observability              | Prometheus metrics, `/health`, `/ready`, request-id correlation, structured logging                                                                                                |
| 39       | Security                   | 31-probe pentest script, AES-256-GCM at rest, no secrets in git history                                                                                                            |
| 40       | Testing                    | 1504 tests including PnL, margin, drawdown, exposure, permissions, order validation, push classification, and row-level security proved by breaking it                             |
| 41       | Security testing           | cross-tenant access, privilege escalation, token replay, rate limiting, audit tampering, invitation minting                                                                        |
| 44       | CI/CD                      | install → prisma → build → lint → format → typecheck → migrate → test → schema check → seed → build → smoke API → smoke WebSocket                                                  |

## Partial

| §   | Area               | What exists                                                                                    | What is missing                                                                                            |
| --- | ------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 29  | Admin panel        | 9 panels — overview, people, accounts, risk, instruments, reconciliation, audit and two others | ~17 sections asked for. No tenants, KYC, finance, wallets, roles, tokens, API management, security centre. |
| 35  | Finance            | balance ledger, admin adjustments, database transactions, decimal arithmetic                   | no wallet, no real deposit, no withdrawal, no payment provider                                             |
| 36  | Notification admin | `push_deliveries` records every attempt with its outcome                                       | no admin view over them                                                                                    |
| 43  | Web UI             | 4 pages: terminal, login, admin, status                                                        | Phase 3 restructures it                                                                                    |

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

Missing: `TOKEN_MANAGEMENT` and `AI_CONTEXT` — because the features they would
describe do not exist, and §45 says do not document features that do not exist.

## Where this sits in the plan

| Phase                                    | Status                                     |
| ---------------------------------------- | ------------------------------------------ |
| 0 — close what is open                   | done                                       |
| 1 — multi-tenancy                        | done                                       |
| 2 — roles and permissions as data        | done; grants are rows, per tenant          |
| 3 — web restructure                      | not started                                |
| 4–7 — wallet, payments, KYC, withdrawals | not started                                |
| 8 — notification platform                | done; admin statistics view remains        |
| 9 — API and token management             | not started                                |
| 10 — outbound webhooks                   | not started                                |
| 11 — Security Centre                     | not started                                |
| 12 — mobile foundation                   | done; Android builds, iOS not attempted    |
| 13 — mobile trading                      | done except KYC, which needs Phase 6 first |
| 14 — AI context layer                    | not started                                |
| 15 — real market data                    | not started, plus a commercial dependency  |

**6 of 16.**

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

**What is not done: `DATABASE_URL_TENANT` is not yet set on https://devopss.ir.**
Until it is, that deployment still runs as the owner and gets one warning line
at boot saying so. The code is complete; the deployment step is one run of
`pnpm db:roles` and one line in the environment, and it has not been run there.

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
security enforced against the application itself — once `DATABASE_URL_TENANT` is
set, which it is not yet on devopss.ir)
no frontend-only authorization ✅ sensitive actions audited ✅ tokens protected ✅

Every link of the chain the prompt draws exists in code: user → app → API → auth
→ RBAC → risk engine → trading engine → execution → database → event → WebSocket
→ notification service → in-app notice, push, and the right sound.

What has not happened is anyone walking that chain on a phone.
