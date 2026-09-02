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

**Capabilities are code; grants are data.** The catalogue below is a
compile-time constant, because code is what checks a capability and one that
exists only as a database row is one no route could require. Which role carries
which capability is a row — `roles` and `role_permissions`, per tenant — because
that is the part a firm needs to change without a deployment, and the part that
differs between firms. The table each tenant starts with is seeded from the
constant, so a fresh deployment behaves exactly as the catalogue below says.

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
| `reconciliation.read` / `.manage` / `.run`        | Read findings; decide one; trigger a run  |
| `master.read` / `.manage`                         | Master-account links                      |
| `system.operations`                               | The operations dashboard                  |
| `system.kill_switch`                              | Halt trading                              |
| `roles.read`                                      | See what each role carries                |
| `roles.manage`                                    | Change what a role carries                |

`accounts.read` and `accounts.read_any` are deliberately separate. Collapsing
them would mean that granting a support agent the ability to look up a customer
also granted every trader the ability to look up every other trader, because
both would be spelled the same way.

## Roles

These are the sets a tenant is **seeded** with. They are rows from then on, so
what a given deployment's roles actually carry is `GET /permissions/roles`, and
this table is what it started as.

| Role           | Carries                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `USER`         | Their own accounts, and the full order and position lifecycle on them                                                              |
| `SUPPORT`      | Read-only across accounts, orders, positions and master links                                                                      |
| `OPERATOR`     | Support's reads, plus cancel/close/modify, account management, ops dashboard                                                       |
| `RISK_MANAGER` | Operator's set, plus `risk.manage`, `audit.read`, reconciliation manage and run, kill switch                                       |
| `ADMIN`        | Everything administrative, plus `roles.read`/`roles.manage` — but **not** `orders.create`, `positions.close` or `positions.modify` |

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

## Editing a role, and the two things that cannot be edited into one

`roles.manage` is the meta-permission: a holder could otherwise grant themselves
everything else on the list. Only `ADMIN` carries it, which is a statement about
whose job this is rather than a safety mechanism — the safety is two refusals,
both server-side, both inside the transaction that records the change.

### You cannot grant what you do not hold

The oldest bound there is. `escalationsIn` compares the requested set against
what the editor's own role carries, and refuses the difference. Note it applies
to the _result_, not the diff: an editor removing a capability they lack is
narrowing a role, and needs no permission beyond `roles.manage`.

The practical consequence is the useful one. An administrator cannot grant any
role `orders.create`, because `ADMIN` does not hold it — the same rule that keeps
administrators out of the order book keeps them from writing themselves in.

### No role may credit an account and trade the credit

`accounts.adjust` may not sit in the same role as `orders.create`,
`orders.modify` or `positions.modify`. This is a **refusal**, not a warning, and
the choice was deliberate: the plan for this phase left it open, and a warning
that can be clicked past is a warning that will be clicked past on a Tuesday
afternoon, leaving an audit record that describes a platform already
misconfigured. The whole argument for `ADMIN` not holding `orders.create` is that
inventing money and using it must not be one person's capability; a rule that
yields is a note about that argument rather than the argument.

`orders.cancel` and `positions.close` are deliberately not on the list. Stopping
something is not starting it — the same distinction that lets `ADMIN` keep them.

`wallet.adjust` is the same power aimed at a different pot, and it is on the list
for the same reason: money invented in a wallet reaches a position through one
transfer the holder is entitled to make on their own wallet.

`payments.confirm` is narrower than either — it can settle only a payment
somebody started, only for the amount they started it for, and it leaves an
intent and an event behind — and it is still a way to make money appear, so it
does not sit beside opening a position either.

The sharpest pair on the list is `payments.confirm` with `payments.create`: start
a deposit for any amount, then confirm it as the operator who saw it on a
statement. Both halves leave a record and both look ordinary alone. Only holding
them together turns them into a credit with no counterparty — and unlike every
other pair, it needs no market to launder through. It is also why starting a
deposit is its own capability rather than part of `payments.read`: a power that
cannot be named cannot be held apart from another.

`kyc.review` with `kyc.submit` is the same shape one step removed: verifying
your own identity is what clears a withdrawal gate, so a role that can both
submit and decide can clear its own path out.

### Money out of nothing, complete

`withdrawals.review` and `withdrawals.pay` may not sit beside `payments.confirm`,
`wallet.adjust` or `accounts.adjust`. Confirm a deposit that never arrived, or
adjust a wallet upward, then approve its withdrawal: the firm pays out money that
never came in. Every other pair on the list needs a market to launder through;
this one does not.

That is why there is a **FINANCE** role and why **ADMIN cannot approve a
withdrawal**. The administrator holds the capabilities that make money appear;
the finance desk holds the ones that let it out; and the editor refuses to put
both halves into either. A deployment needs at least one person in each, and
the platform will not pretend otherwise for a single operator. See
[withdrawals.md](./withdrawals.md).

### Putting a person into a role

`POST /admin/users/:id/role` needs `roles.assign`, which ADMIN holds and
`users.manage` does not include — changing what a person may do is the one act
that changes every other check, and it is granted and audited on its own. It
refuses your own id, so an administrator can neither promote themselves by
stages nor demote themselves with nobody left to undo it; and it ends every
session the person has, because the role travels in the access token and a
session minted before the change would keep the old capabilities until it
expired.

The escape is the one separation of duties always has: two roles, two logins, or
a master-account link that names the account and leaves a record.

The first administrator cannot be appointed this way, because appointing needs
one. That act belongs to the host: `scripts/first-administrator.sh` runs the
compiled CLI inside the migrate image, does what the endpoint does with actor
`SYSTEM` and the host's name in the audit row, and refuses once an active
administrator exists. See [deployment.md](./deployment.md#the-first-administrator).

### What a release does to roles that already exist

Grants became rows so a firm could change them without a deployment. That made
the reverse case a problem nobody had before: a release that _adds_ a
capability — `wallet.read` on the trader role, say — cannot reach a tenant whose
roles were seeded earlier. The feature then works in every test and answers 403
in production. That is not hypothetical; it is how the wallet phase's own pentest
probe failed.

So a reconciliation runs, and it treats four kinds of role differently:

| The role                            | What the deploy does                        |
| ----------------------------------- | ------------------------------------------- |
| Missing entirely                    | created from the shipped set                |
| Built-in, **never edited**          | set to the shipped set — additions included |
| Built-in, **edited by an operator** | left exactly as they left it                |
| Created by the firm, not shipped    | left alone                                  |

`roles.grants_edited_at` is what tells the second from the third. It is stamped
by `PUT /permissions/roles/:key` and cleared by the reset below, so restoring a
role also hands it back to the build.

The asymmetry is deliberate. A deploy that silently re-widened a role somebody
had deliberately narrowed would be the worst kind of regression, because nothing
about it would look wrong.

**Where it runs, and why that had to change.** For one phase this lived only in
the database seed — and the seed is not what a deployment runs. `prisma migrate
deploy` applies migrations; nothing called the reconciliation. So the gap the
mechanism was built to close stayed open on exactly the platforms that mattered:
the payments phase shipped three capabilities, and a freshly registered trader on
an upgraded deployment was refused `GET /payments/providers` because
`payments.read` existed in a constant and in no row. It was the phase's own smoke
check that caught it.

`RolesService` now reconciles at boot, for every tenant. It is idempotent — a
role already matching the build is skipped without a write — so every replica
doing it on every start is harmless, and a replica that cannot do it logs and
serves anyway rather than refusing to start. An API that cannot reconcile roles
must still enforce the roles it can read.

### Putting a role back

`POST /permissions/roles/:key/reset` restores a built-in role to the set this
build ships with, and is deliberately **exempt from the escalation rule**.

That looks like a hole and is the opposite. The rule exists because the editor
chooses the set; here the request names a role and the set comes from the build,
so there is nothing to escalate _to_. Without the exemption the default `USER`
role would be permanently unrestorable by anyone, because it carries
`orders.create` and no administrator holds that.

Only roles this build ships. A role somebody created here has no defaults, and
emptying it and calling that "restored" would be a way to disable a role while
appearing to fix one. The incompatibility rule still applies.

### What is recorded

Every change writes an audit row **inside the same transaction** as the grant,
with the before and after sets and the difference in both directions. Every other
audit call in this codebase is fire-and-forget, for a good reason — losing the
record of a fill beats losing the fill — but a silent alteration of what a role
may do is indistinguishable from an intruder's, and there is no version of that
operation worth keeping without its record. `AuditService.record` takes an
optional transaction for exactly this case, and throws rather than logging when
it is given one.

### When the database will not answer

The guard used to be a pure function, so it could not fail. Now it reads rows,
and a permission check that throws is every route returning 500. Three
behaviours, in order:

| Situation                                   | What happens                               |
| ------------------------------------------- | ------------------------------------------ |
| Reload fails, this tenant was loaded before | the last known grants, logged at error     |
| Reload fails, never loaded                  | the compile-time grants, logged at error   |
| The tenant has **no roles at all**          | the compile-time grants, logged at error   |
| The tenant has roles but not **this** one   | **nothing** — a deleted role holds nothing |

The last two rows look alike and are not. A tenant with no roles never got
seeded, which is infrastructure, and denying everything would take a firm offline
over it. A tenant missing one role had it deleted, which was a decision, and
restoring its default would make deletion do nothing.

Grants are cached per tenant and dropped on every instance over Redis when one
changes, so an edit takes effect immediately rather than at the next expiry.

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

| Break                                           | Caught by                    |
| ----------------------------------------------- | ---------------------------- |
| Guard never refuses                             | 5 of 8 guard tests           |
| Decorator writes metadata under a different key | 6 of 8 guard tests           |
| `and` semantics become `or`                     | catalogue test + guard test  |
| Guard is never registered as an `APP_GUARD`     | coverage test                |
| Guard reads the constant instead of the rows    | 7 of 21 role tests           |
| Incompatible combinations allowed               | role test + pentest probe    |
| Editor may grant what they do not hold          | 2 role tests + pentest probe |
| A deleted role falls back to its default        | role test                    |
| The audit row moves outside the transaction     | role test                    |

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

## A key is a role's subset, a token is a firm's

A role is what a person may attempt. An **API key** is a subset of that, fixed
when the key is minted and intersected with the role on every use, carried by
a script rather than a browser. `PERSON_ONLY_PERMISSIONS` names what a key may
never carry — money in, money out, roles, identity documents, keys themselves
— and `KEYABLE_PERMISSIONS` is everything else. A **service token** belongs to
the firm and carries only `SERVICE_GRANTABLE_PERMISSIONS`: reads across the
tenant, because the audit log has no way yet to name a machine that wrote. Both
may carry only what the person minting them holds, which is the same rule as
editing a role. The permission guard reads a credential's own set rather than
its holder's role, and refuses a credential every route that declares no
capability. See [api-keys.md](./api-keys.md).

Four capabilities came with them: `api_keys.manage` (your own; every person),
`api_keys.read_any` (staff see who holds what), `api_keys.revoke_any` (risk
management and administration end anyone's), and `service_tokens.manage`
(administration only).

## The administrative surface

`apps/api/src/admin/` is one controller, so the question "what can an
administrator do" has one file as its answer.

### The split that runs through it

| Power                               | Permission        | Held by                                |
| ----------------------------------- | ----------------- | -------------------------------------- |
| See any user                        | `users.read_any`  | SUPPORT, OPERATOR, RISK_MANAGER, ADMIN |
| Suspend, sign out, unlock           | `users.manage`    | RISK_MANAGER, ADMIN                    |
| Freeze, restrict, close an account  | `accounts.manage` | OPERATOR, RISK_MANAGER, ADMIN          |
| Change an account's risk thresholds | `risk.manage`     | RISK_MANAGER, ADMIN                    |
| **Post a ledger entry**             | `accounts.adjust` | **ADMIN only**                         |
| Read the audit trail                | `audit.read`      | RISK_MANAGER, ADMIN                    |

`accounts.adjust` is deliberately not implied by `accounts.manage`. Managing an
account changes what it may _do_; adjusting it changes what it is _worth_, and
there is no version of the second that is a smaller act than the first. It is
also absent from `LINKABLE_CAPABILITIES`, so a master-account link cannot carry
it.

### Suspension ends sessions

`setUserActive(false)` revokes every refresh token in the same call. Marking a
user inactive on its own leaves whoever is signed in able to keep trading until
their access token expires — which reads, afterwards, as a suspension that did
nothing.

It does **not** revoke access tokens, because those are stateless and cannot be
recalled. That is why the access-token lifetime is short, and why `revokeAll`
says so in its own documentation rather than letting an administrator believe a
compromised session is dead the instant they click.

### Three actions, not one

- **suspend** — stop them signing in _and_ end their sessions.
- **sign out** — end their sessions and let them straight back in. A stolen
  laptop.
- **unlock** — clear a lockout from failed attempts. A forgotten password, not a
  punishment to be lifted.

Collapsing them into one "disable" would make the wrong one convenient.

### Balance adjustments

There is no endpoint anywhere that _sets_ a balance. §37 forbids arbitrary
balance editing, and the reason is worth stating rather than citing: a balance
that can be written directly is a balance whose history is a lie.

`POST /admin/accounts/:id/adjustments` appends through the same
`LedgerService.post` a trade uses, inside the same account lock. It demands
three things:

1. `accounts.adjust`, which nobody holds by default;
2. a current TOTP code from the administrator — the only action in the platform
   that asks for a second factor after sign-in, because it is the only one that
   creates money;
3. a reason in words, stored on the ledger row and in the audit record.

The caller's idempotency key becomes the ledger row's `idempotencyKey`, which
carries a unique constraint: a retried request cannot credit twice, and that is
the database's guarantee rather than a promise.

A debit that would take the balance below zero is refused. A negative cash
balance is not a state this platform has rules for — it is not a margin loan,
and nothing downstream knows how to charge interest on it or collect it.

### Refusals are proved over HTTP

`pnpm pentest` includes three probes that attempt the whole administrative
surface with an ordinary trader's token: reading every user, changing another
user's state, and crediting an account. Each asserts a 403 _and_ that nothing
moved — the last one checks the attacker's balance and that no
`admin_adjustment` ledger row exists.

## Why closing a finding is not a read

`reconciliation.read` shows a discrepancy. `reconciliation.manage` decides what
it means — acknowledged, investigating, resolved, false positive. They are
separate because closing a finding is a write, and a permission whose name says
read must not authorise one.

They were the same permission until an inventory of the API noticed that
`OPERATOR`, who holds read and not run, could mark a money discrepancy resolved.
That is not an outrageous power, but it is the power to make a discrepancy stop
being visible, and it belongs with risk management rather than with operations.

An operator can still see every finding and escalate it. What they can no longer
do is close it.
