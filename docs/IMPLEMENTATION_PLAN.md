# Implementation Plan

**Baseline:** commit `76fd42a`, branch `feat/m1-realtime-terminal`.
1,095 tests across 86 files, green. Deployed and verified on `devopss.ir`.

**Target:** the multi-tenant commercial trading ecosystem described in the master
specification — mobile applications, KYC, wallet and payments, an integration
platform, a security centre, and an AI layer.

---

## Read this first

The distance between the baseline and the target is **months of engineering, not
weeks.** This document sequences that distance honestly. It does not pretend the
work is nearly done, and it does not pad the existing platform's achievements to
make the remainder look smaller.

What exists is a well-built single-tenant trading platform: a deterministic
decimal financial core, an append-only ledger, a real risk engine, a working
realtime terminal, an admin console, reconciliation, and adversarial security
testing. That is a genuine asset and the plan is built to preserve it. The
specification's instruction — _do not blindly rewrite, do not delete working
functionality, do not replace working architecture out of preference_ — is the
governing constraint on every phase below.

## The ordering principle

Two rules decide the sequence, and they override any wish to build the exciting
parts first.

**1. Tenancy goes first, because its cost grows with every commit.**
Retrofitting `tenantId` into 29 models and 84 routes is expensive today and more
expensive after another 40 routes exist. Every phase after Phase 1 assumes it.

**2. Nothing user-facing is built on a surface that has to move.**
The web app is one page. Wallet, KYC, security centre and API keys have nowhere
to live, and bolting eight panels onto the terminal would produce work that must
be redone. The restructure is small and it comes early.

## Definition of Done

Applied per phase, from the specification. A feature is complete only when
**UI → API → business logic → database → authorization → security → audit →
tests** are connected. Specifically, for every phase:

- Backend enforces every permission. Frontend permission logic is presentation.
- No floating point anywhere near money.
- Every mutation writes an audit record with before and after state.
- Tenant identity is derived from the authenticated context, never from input.
- No secret is stored raw, logged, or committed.
- `pnpm verify` green, and `pnpm smoke` green — because `verify` does not boot
  the application and `smoke` does. That distinction has already cost one
  production outage in this repository.

---

## Phase 0 — Close what is open · ~1 day

Not a feature. Three defects that should not survive another week.

| Item                                                                                         | Why now                                                                                                   |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Gate registration (`REGISTRATION_MODE=closed\|invite\|open`, default `closed` in production) | A public domain currently accepts anyone                                                                  |
| Remove the 21 test accounts from the production database                                     | Left over from verification runs                                                                          |
| `REVOKE UPDATE, DELETE ON audit_logs` from the application role                              | The specification requires administrators cannot alter audit logs; today only the application prevents it |
| Add `RECONCILIATION_MANAGE`; move the finding-status write off `RECONCILIATION_READ`         | A write gated by a read permission                                                                        |

**Done when:** registration refuses an uninvited address in production, the
database refuses an `UPDATE` on `audit_logs`, and the pentest script has a probe
for each.

---

## Phase 1 — Multi-tenancy · ~3–4 weeks · **the hinge of the whole plan**

The largest single item and the one everything else waits on.

**Schema.** A `Tenant` model; `tenantId` on the ~20 owned models. `Symbol`,
`SymbolSpec`, `MarketSession` and `Candle` stay global — instruments are a
platform fact; their _commercial terms_ become tenant-scoped, which the existing
split between contract spec and terms already accommodates.

**The sharp edge is `User.email`.** It is globally unique today. The same person
may be a user of two tenants, so it becomes `@@unique([tenantId, email])` — and
that is a behavioural change to login, not merely a schema change. Login must
resolve the tenant before it resolves the user, which means the tenant comes
from the hostname or an explicit tenant selection, and is then fixed for the
session.

**Enforcement, in two layers, because one is not enough.**

1. A Prisma client extension that **refuses** a query against a tenant-scoped
   model when no tenant filter is present. Forgetting must be a crash, not a
   leak. A guard that silently permits an unscoped query is worse than none,
   because it is trusted.
2. Postgres row-level security beneath it, so that a bug in layer 1 is still
   contained by the database.

**Derivation.** The tenant comes from the authenticated context. Not a header,
not a body field, not a query parameter. The specification states this and it is
right: the moment a client can name its tenant, the boundary is decorative.

**Realtime.** Rooms become tenant-namespaced. A subscription check must verify
tenant before account.

**Tests.** A cross-tenant probe per resource type, added to `pnpm pentest`: Tenant
A's token against Tenant B's account, order, position, ledger, notification,
audit entry. Each must return a not-found, not a forbidden — a forbidden confirms
the resource exists.

**Migration.** All existing rows become one default tenant. Data migration is
trivial; code migration is not.

**Done when:** every tenant-scoped model carries `tenantId`, the extension throws
on an unscoped query, RLS is enabled, the cross-tenant probes pass, and the
existing 1,095 tests still pass.

---

## Phase 2 — Roles and permissions as data · ~1 week

Today roles are TypeScript constants; a new role is a deployment. Under tenancy
each tenant defines its own.

`Role` and `PermissionGrant` become rows, seeded from today's constants so
behaviour is identical on day one. `ALL_PERMISSIONS` stays a compile-time
constant — permissions are code because code checks them; the _grants_ become
data.

**The one rule that must survive this change:** `ADMIN` holds no trading
permission. When roles become editable, someone will grant their admin role
`orders.create` on a Tuesday afternoon. Either the platform forbids the
combination of `accounts.adjust` and `orders.create` in one role outright, or it
warns loudly and audits the grant. This must be decided in this phase, not
discovered later.

---

## Phase 3 — Web application restructure · ~1 week

Route groups around the existing terminal. **The terminal is not rewritten** —
it moves from `/` to `/terminal` and the shell around it gains real routes:
`/account`, `/history`, `/wallet`, `/security`, `/settings`, and nested admin
routes `/admin/people/:id`, `/admin/accounts/:id`.

Small phase, early, because every later feature needs somewhere to live and
because deep-linking is what an operator working an incident actually needs.

---

## Phase 4 — Wallet and finance · ~2–3 weeks

`Wallet` and `WalletTransaction`, on top of the existing `BalanceLedger` rather
than beside it. The ledger stays the source of truth for account balance; the
wallet is the user-facing funds surface and its movements post to the ledger.

Two ledgers that both believe they are authoritative is the classic way to lose
money in an accounting system. Not repeating it is the whole design constraint
of this phase.

Decimal throughout. Idempotency keys on every credit. Full audit.

---

## Phase 5 — Payments · ~2–3 weeks

Provider-agnostic behind an adapter, the same way market data is. `PaymentIntent`
with an explicit state machine; provider webhooks; **idempotent handlers keyed on
the provider's event id**, because a payment provider will deliver the same
webhook twice and one of those must not credit twice.

A failed payment must never create funds. The ledger's existing unique
`idempotencyKey` already gives the mechanism.

**Provider selection is a business decision, not an engineering one**, and it
gates this phase.

---

## Phase 6 — KYC · ~2–3 weeks

`KycRecord`, `KycDocument`, a review workflow, an admin queue. Documents are
identity documents: encrypted at rest, access audited, retention policy stated,
and never in application logs.

Kept separate from trading logic, per the specification. A withdrawal may require
verified KYC; opening a position does not.

---

## Phase 7 — Withdrawals · ~1–2 weeks

`WithdrawalRequest` with approval workflow, limits, cooldowns, and a KYC gate.
Depends on Phases 4, 5 and 6 — it is the point where all three meet, which is
why it is not merged into any of them.

---

## Phase 8 — Notification platform · ~2 weeks

`NotificationPreference` per user, per channel, per kind. `PushDevice` for FCM
and APNs tokens. Worker dispatch per channel. Trading sounds as a client-side
concern driven by server events.

**The specification's rule here is a correctness requirement, not a preference:**
a notification — and a sound — fires when the backend confirms execution, never
when the user clicks Buy. The event stream already emits `order.filled` and
`position.opened` server-side, so the correct implementation is also the simple
one, provided nobody wires a sound to a click handler.

This phase is a prerequisite for mobile being useful, which is why it precedes it.

---

## Phase 9 — API and token management · ~2 weeks

`ApiKey` and `ServiceToken`, scoped to a tenant, with per-key permissions, an
expiry, and revocation.

The specification's rule, without exception: **never store the raw secret; hash
it; store a fingerprint for identification; show the generated secret exactly
once.** A platform that can show a user their existing API key is a platform
that stored it.

This is also the surface the future PropFA product consumes, which makes its
design a boundary decision rather than a convenience feature.

---

## Phase 10 — Outbound webhooks · ~1–2 weeks

`Webhook` and `WebhookDelivery`. Signed payloads, exponential backoff, a delivery
log, replay from the log. Subscribers to the existing domain events — the event
bus already exists and already mints a stable `eventId` per occurrence, which is
exactly what a consumer needs to deduplicate.

---

## Phase 11 — Security Center · ~1–2 weeks

Mostly surfacing what already exists: sessions, devices, IP history, 2FA state,
audit of one's own account, active API keys. Plus `SecurityEvent` as a
first-class feed rather than a filter over `AuditLog`.

Small, high-value, and it lands late only because it is worth more once there is
more to show.

---

## Phase 12 — Mobile foundation · ~3–4 weeks

Backend first: refresh-token delivery by client type — `Set-Cookie` for web,
response body for native, **with the server deciding, never the client asking.**
Then FCM and APNs wiring on top of Phase 8. Then `apps/mobile` as an Expo
workspace consuming `@tp/shared-types` and `@tp/financial-core` by workspace
reference, and an app shell with auth, accounts and push.

`MOBILE_AUDIT.md` §3 has the reasoning for not simply moving the web client to
body-delivered tokens.

---

## Phase 13 — Mobile trading · ~4–6 weeks

Terminal, charts, positions, orders, watchlist, notifications, biometric unlock.
Then two app-store submissions, which have their own timelines that no amount of
engineering shortens.

**The rule that must not bend:** mobile uses the same `/orders` route as the
browser. If mobile needs different behaviour, it gets a different transport to
the same service — never a different service. The way "never bypass the risk
engine" gets violated is never deliberate; it is a lightweight endpoint added for
latency that skips a check the main path performs.

---

## Phase 14 — AI context layer · ~2–3 weeks

An abstraction that answers questions about platform state through a **defined,
read-only, permission-scoped, tenant-scoped, audited** interface.

The specification's constraints are absolute and they are the design: **no
unrestricted database access, no arbitrary SQL, no direct database manipulation.**
The AI layer calls the same services a user's session would, under the same
permission checks, and every call is audited. It is a consumer of the platform,
not a privileged path into it.

---

## Phase 15 — Real market data · ~3–4 weeks, plus a commercial dependency

The provider interface is already the correct seam. Behind it today is a
simulator; nothing real has ever traded here.

Needs: a data vendor, a broker or liquidity relationship, execution semantics
including slippage and requotes, and a separate audit of its own. It is last
because it is the phase where the platform stops being a simulation, and
everything preceding it should be correct before that is true.

---

## Sequence and dependencies

```
Phase 0  ─┐
Phase 1  ─┴─▶ everything            (tenancy first, always)
Phase 2  ───▶ 9, 11
Phase 3  ───▶ 4, 6, 11
Phase 4  ───▶ 5 ─▶ 7
Phase 6  ───────────▶ 7
Phase 8  ───▶ 12 ─▶ 13
Phase 9  ───▶ 10
Phase 14 ─── independent, needs 1 and 2
Phase 15 ─── independent, gated commercially
```

## Total, stated plainly

Sequentially, by one engineer: **roughly nine to twelve months.** With a team
working the parallel tracks — trading/backend, finance/compliance, mobile — the
critical path is shorter, but Phase 1 blocks everything and cannot be
parallelised away.

Anyone who tells you this is a few weeks of work has not read the specification
or has not read the repository.

## What will not be touched

`financial-core`, `trading-core`, `risk-core`, the balance ledger, the order and
position state machines, the trigger engine. They are correct, they are tested,
and re-deriving them would be the most expensive mistake available in this
programme.

They will gain `tenantId` where they touch persistence. Their arithmetic will not
change.
