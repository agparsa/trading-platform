# Permissions

A role field on a user is a statement about who somebody is. It is not, by
itself, an answer to "may this request proceed" — that answer has to be computed
per route, in the backend, on every call. This document is the catalogue and the
reasoning behind it.

The frontend also reads this catalogue, and uses it only to hide controls nobody
can operate. Hiding a button is courtesy. Anyone can send the request the hidden
button would have sent, and the server refuses it there.

## Shape

Permissions are `resource.verb` capabilities, defined once in
[`packages/shared-types/src/permissions.ts`](../packages/shared-types/src/permissions.ts)
so the API and the terminal cannot drift apart on what a name means.

Roles are **sets of capabilities, not a ladder**. There is no rank at which one
role automatically contains another, because the useful distinctions here are
not hierarchical: a risk manager may halt trading and a support agent may not,
while a support agent and an administrator can both read an account and neither
should be able to place an order on it.

| Capability                                        | Meaning                                   |
| ------------------------------------------------- | ----------------------------------------- |
| `accounts.read`                                   | Read **your own** accounts                |
| `accounts.read_any`                               | Read anyone's account                     |
| `accounts.manage`                                 | Change account settings, leverage, status |
| `orders.read` / `.create` / `.modify` / `.cancel` | Order lifecycle                           |
| `positions.read` / `.close` / `.modify`           | Position lifecycle, including SL/TP       |
| `risk.read` / `.manage`                           | Read risk state; change limits            |
| `audit.read`                                      | Read the audit log                        |
| `integrity.read` / `.manage`                      | Integrity signals; act on them            |
| `reconciliation.read` / `.run`                    | Reconciliation reports; trigger a run     |
| `master.read` / `.manage`                         | Master-account links                      |
| `system.operations`                               | The operations dashboard                  |
| `system.kill_switch`                              | Halt trading                              |

`accounts.read` and `accounts.read_any` are deliberately separate. Collapsing
them would mean that granting a support agent the ability to look up a customer
also granted every trader the ability to look up every other trader, because
both would be spelled the same way.

## Roles

| Role           | Carries                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `USER`         | Their own accounts, and the full order and position lifecycle on them                            |
| `SUPPORT`      | Read-only across accounts, orders, positions and master links                                    |
| `OPERATOR`     | Support's reads, plus cancel/close/modify, account management, ops dashboard                     |
| `RISK_MANAGER` | Operator's set, plus `risk.manage`, `audit.read`, reconciliation runs, kill switch               |
| `ADMIN`        | Everything administrative — but **not** `orders.create`, `positions.close` or `positions.modify` |

### Why ADMIN cannot trade

This is the one entry that surprises people, so it is worth stating plainly.

Placing an order on somebody else's account is not an administrative act. It
moves that person's money, and it produces a fill that will appear in their
statement with no explanation attached. Making it a property of being an
administrator means any compromised admin session is also a trading session on
every account in the system.

So the capability is not granted by rank. It is granted per master-account link,
to a specific operator, over a specific account, by an act that is itself
audited — which is what the master account domain exists to express. An
administrator who genuinely needs to trade an account gets a link like anybody
else, and the link is the record of why.

`ADMIN` keeps `positions.read` and `orders.cancel`, because stopping something
and understanding something are different from starting something.

### Why RISK_MANAGER holds the kill switch and ADMIN does too

Halting trading is a safety action, and safety actions should not require
finding the one person with the right title at 3am. Both roles carry it, both
uses are audited, and — per the specification's §21 — a halt must never remove
the ability to _close_ a position. Trapping traders in open risk is not a safe
state.

## Enforcement

Three layers, each with its own failure mode covered:

1. **Declaration.** `@RequirePermissions(...)` on the route. Multiple
   permissions mean **all of them**, not any — a route that needs two
   capabilities needs both.
2. **The guard.** `PermissionsGuard`, registered globally as an `APP_GUARD`,
   reads the declaration and refuses what the role does not carry. The refusal
   names the missing capability, so an operator who cannot do something knows
   which capability to ask for rather than filing "it says no".
3. **Coverage.** A test walks every controller and fails the build if a
   mutating route (`@Post`, `@Patch`, `@Put`, `@Delete`) declares nothing.

The third layer exists because the guard is deliberately permissive about
routes with no declaration. Failing closed at runtime would mean a forgotten
decorator takes trading down; failing closed at build time means it never
ships. A route that genuinely should be open says so out loud — `@Public()` for
registration and login, `@SelfService()` for acting on your own record — so the
reader sees a decision rather than an omission.

## How this was verified

Every layer was checked by breaking it and confirming something failed:

| Break                                           | Caught by                   |
| ----------------------------------------------- | --------------------------- |
| Guard never refuses                             | 5 of 8 guard tests          |
| Decorator writes metadata under a different key | 6 of 8 guard tests          |
| `and` semantics become `or`                     | catalogue test + guard test |
| Guard is never registered as an `APP_GUARD`     | coverage test               |

The last one is the reason the registration is asserted as text in a test:
deleting that one line in `app.module.ts` left the entire unit suite green. A
guard that is written, reviewed and never wired enforces nothing, and nothing
about the code's appearance says so.

Over HTTP, `pnpm smoke` demotes a real user to `SUPPORT`, logs in again for a
token carrying the new role, and asserts both halves: placing an order is
refused with `FORBIDDEN` naming `orders.create`, and a capability `SUPPORT` does
hold still reaches the handler. Unit tests prove the guard computes the right
answer; only this proves the guard is on the path a request actually takes.

The order in that check uses a nonexistent account id on purpose. The guard must
refuse before the handler looks anything up — a `RESOURCE_NOT_FOUND` there would
mean permission was decided after the request had already reached data it was
not entitled to touch.

## Roles are not the whole story

Two things this layer deliberately does not do:

- **It does not decide whose account it is.** A `USER` carries
  `positions.close`; that says nothing about _which_ positions. Ownership is
  checked in the service against the authenticated user id, and always was.
  Permissions narrow what a role may attempt; they never widen what a user may
  reach.
- **It does not grant cross-account access.** Acting on another person's account
  goes through a master-account link — a separate grant, over one account, with
  its own record. See [master-accounts.md](./master-accounts.md). Knowing an
  account id has never been, and must never become, a way to reach it.

One consequence to be honest about: `accounts.read_any` is in the catalogue and
currently grants nothing. Every account read resolves through ownership or a
link, and neither consults it. It is the capability a support surface will
declare when there is one to declare it; until then it is a name with no
enforcement behind it, which is worth stating plainly rather than leaving for
someone to discover.
