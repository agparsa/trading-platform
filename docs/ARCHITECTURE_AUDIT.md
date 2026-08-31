# Architecture Audit

**Audited:** commit `76fd42a`, branch `feat/m1-realtime-terminal`
**Method:** direct inspection of the repository. Every count in this document was
produced by a command against the working tree, not from memory or from another
document. Where a claim could not be verified by inspection it is marked
**UNVERIFIED** and says what would verify it.

---

## 1. What this repository is

A standalone, self-contained trading platform: accounts, market data, an order
and position engine, a risk engine, a realtime gateway, an admin console, and a
reconciliation subsystem. It is **not** a prop-firm product and contains no
challenge, evaluation, or payout logic; that is a deliberate boundary, and the
platform is meant to expose clean APIs that a separate PropFA product can build
on.

## 2. Shape of the codebase

```
apps/
  api      NestJS 11 HTTP + WebSocket server      132 files   17,744 lines
  web      Next.js 15 App Router (React 19)        70 files   13,571 lines
  worker   NestJS 11 BullMQ consumer               12 files    1,185 lines
packages/  nine framework-free domain libraries    86 files    7,974 lines
scripts/   operational and verification tooling    11 files    5,020 lines
prisma/    schema + seed                            2 files    1,293 lines
docs/      architecture and operations notes       48 files    7,068 lines
```

Source only — `dist/`, `.next/` and `node_modules/` excluded. An earlier count
of 147 package files included build output and is superseded by this one.

The nine packages are `shared-types`, `financial-core`, `market-core`,
`trading-core`, `risk-core`, `reconciliation-core`, `integrity-core`,
`api-client`, `ui`. They are framework-free by ESLint rule, not by convention —
a package cannot import NestJS or React and still lint.

**Assessment: this is the strongest thing in the repository.** The domain logic
that decides money — margin, P&L, rounding, state machines — lives in libraries
that have no idea a web server exists. That is what makes it testable, and it is
why the test suite can assert on financial behaviour without booting anything.

## 3. Runtime topology

```
browser ── HTTPS ──▶ Next.js (web)
   │                   │
   └── WebSocket ──────┼──▶ NestJS api ──▶ PostgreSQL 16
                       │         │
                       │         ├──▶ Redis 7 ── pub/sub + BullMQ
                       │         │                     │
                       │         │                     ▼
                       │         │                 worker (swap accrual,
                       │         │                  reconciliation,
                       │         │                  notifications, maintenance)
                       └─────────┘
```

In production the chain in front of this is ArvanCloud CDN → cPanel nginx :443 →
Apache :81/:444 → stack nginx 127.0.0.1:8443 → api/web. That chain is documented
in `deployment-cpanel.md` and is a constraint of the customer's shared host, not
a design choice.

## 4. API surface

15 controllers, **84 HTTP routes**: 43 `GET`, 35 `POST`, 3 `PATCH`, 3 `DELETE`.
The full route-by-route listing with the permission each one demands is in
[`API_INVENTORY.md`](./API_INVENTORY.md).

3 WebSocket message handlers (`subscribe`, `unsubscribe`, `whoami`) and 24
distinct domain event names on the outbound side.

## 5. Authorization model

Five roles — `USER`, `SUPPORT`, `OPERATOR`, `RISK_MANAGER`, `ADMIN` — and 30
named permissions. Roles are declared as explicit sets, never as a ladder where a
senior role inherits a junior one. That decision is load-bearing: `ADMIN` holds
`accounts.adjust` but deliberately holds **none** of `orders.create`,
`positions.close`, `positions.modify`, on any account including its own, so that
nobody can credit an account and then trade the credit.

Four guards are registered globally (`ThrottlerGuard`, `JwtAuthGuard`,
`RolesGuard`, `PermissionsGuard`), and a coverage test asserts the `APP_GUARD`
registration still exists — because deleting that one line would leave every unit
test passing while the API became public.

## 6. What is genuinely complete

Complete here means the master specification's own bar: **UI → API → business
logic → database → authorization → security → audit → tests, all connected.**

| Area                                                                      | State    |
| ------------------------------------------------------------------------- | -------- |
| Registration, login, email verification, password reset                   | Complete |
| TOTP 2FA with recovery codes, sealed secret at rest                       | Complete |
| Refresh tokens in httpOnly cookies, rotation, revocation                  | Complete |
| Session / device / IP visibility and revocation                           | Complete |
| Accounts, append-only balance ledger, snapshots                           | Complete |
| Market data: simulator + scripted providers, candles, integrity checks    | Complete |
| Market orders, resting LIMIT/STOP, SL/TP trigger engine                   | Complete |
| Position open / modify / close / reverse, partial closes                  | Complete |
| Margin, equity, free margin, margin level, stop-out                       | Complete |
| Risk engine: exposure, limits, margin call, stop out                      | Complete |
| Realtime gateway: envelope, `eventId`, sequence, dedupe, replay           | Complete |
| Admin console: people, accounts, risk, audit, reconciliation, instruments | Complete |
| Reconciliation runs and findings                                          | Complete |
| Integrity signals (anti-abuse)                                            | Complete |
| In-app + email notifications with a dedupe key                            | Complete |
| Audit log on every sensitive operation                                    | Complete |
| Observability: Prometheus metrics, health, readiness                      | Complete |
| Deployment: four Docker images, compose files, first-deploy script        | Complete |

## 7. What is incomplete

| Area                      | State                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trader web UI             | One page. The terminal is `/`, plus `/login`, `/admin`, `/status`. There is no account overview, no history page, no profile page, no settings page as routes — they are panels inside the terminal. |
| Notification delivery     | `IN_APP` and `EMAIL` only. No push, no SMS.                                                                                                                                                          |
| Instrument administration | Enable/disable and commercial terms only; contract specs are deliberately immutable.                                                                                                                 |
| Email transport           | **UNVERIFIED** in production. Verified by sending a real registration mail on the deployed host and reading the log.                                                                                 |

## 8. What is missing outright

Every one of these was checked by name against the schema and the source. The
count is zero occurrences, not "a partial implementation".

| Required by the master specification                     | Present                                         |
| -------------------------------------------------------- | ----------------------------------------------- |
| `Tenant` entity, `tenantId` on owned entities            | **No — zero occurrences anywhere**              |
| Android application                                      | **No**                                          |
| iOS application                                          | **No**                                          |
| KYC (records, documents, review workflow)                | **No**                                          |
| Wallet / deposits / withdrawals as a user-facing feature | **No** — only admin-posted ledger entries       |
| Payment provider integration                             | **No**                                          |
| `ApiKey` / `ServiceToken` management                     | **No**                                          |
| Outbound webhooks                                        | **No** — the word appears in three comments     |
| `PushDevice`, FCM, APNs                                  | **No**                                          |
| `NotificationPreference`                                 | **No**                                          |
| Trading sound events                                     | **No**                                          |
| Security Center (as a product surface)                   | **No** — the pieces exist, the surface does not |
| AI context abstraction layer                             | **No**                                          |
| `Role` / `Permission` as database rows                   | **No** — they are TypeScript constants          |

## 9. Risks, ordered by what they would cost

**1. There is no tenancy, and adding it later touches everything.**
Twenty-nine models, 84 routes, every query, every WebSocket room, every admin
screen. This is the single largest item in the programme and it gets harder every
week more code is written. It must go first.

**2. Registration is open on a public domain.**
`https://devopss.ir` accepts anyone. 21 test accounts from earlier verification
runs are still in the production database. Until registration is closed or gated,
the deployment is a demo that anyone can enter.

**3. `ADMIN` cannot trade, and nobody expects that.**
This is correct and deliberate, but it surprises every operator once. It is
documented in `permissions.md` and in the permission table itself; it is listed
here as a risk because it will be reported as a bug.

**4. Roles are compile-time constants.**
A new role means a deployment. For a single-firm platform that is fine. For a
multi-tenant platform where each tenant wants its own roles, it is not.

**5. The web app is one page.**
It works, and it is a genuinely good trading terminal. But every new surface the
specification asks for — wallet, KYC, security centre, API keys — has nowhere to
live, and bolting eight more panels onto one page is not the answer.

## 10. What must be refactored, and what must not

**Must not be touched:** `financial-core`, `trading-core`, `risk-core`, the
ledger, the state machines, the order and position engines. These are correct,
tested, and expensive to re-derive. The specification's instruction not to
rewrite working architecture applies here most of all.

**Must be extended, not replaced:**

- `prisma/schema.prisma` — add `tenantId`, do not restructure existing models.
- `PermissionsGuard` — add tenant derivation alongside permission checking.
- `RealtimeGateway` — namespace rooms by tenant.
- The web app — introduce route groups around the existing terminal, do not
  rewrite the terminal.

**Should be added as new surfaces:** everything in §8.

## 11. Honest summary

What exists is a well-built single-tenant trading platform with a deterministic
financial core, an append-only ledger, real risk enforcement, a working realtime
terminal, and an admin console — deployed and verified against a live host.

What the master specification describes is a multi-tenant commercial trading
ecosystem with mobile applications, a payments and KYC stack, an integration
platform, and an AI layer. That is a different and much larger product, and
roughly speaking the repository is the trading engine at its centre.

The plan in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) sequences the
difference. It is months of work and it is stated as such rather than implied to
be near.
