# Brokers, and the two kinds of tenant

A broker **is a tenant**. That was already true of the isolation — every
broker-owned row carries a `tenant_id`, the Prisma extension refuses a query
with no tenant in scope, and row-level security refuses one that names the
wrong tenant ([multi-tenancy.md](./multi-tenancy.md)). What this phase adds is
the vocabulary: which tenant runs the platform, which roles each kind of tenant
has, and how a broker comes into being.

## `Tenant.kind`

Two values. **PLATFORM** is the one tenant that operates the deployment: it
seeds the platform roles, it is the only place `/admin/brokers` answers, and —
in a single-operator deployment — it is also a firm that trades, which is why
it seeds every role group rather than only its own. **BROKER** is every other
tenant. The migration marks the oldest tenant as the platform, because every
deployment so far has exactly one; a deployment that already had several reviews
that by hand.

The kind is not a row anybody edits from the API. It is what the check in
`BrokersService.assertPlatform` reads, and that check is deliberately not a
capability: a capability is a row somebody with `roles.manage` can add, and "a
broker that can create brokers" is not a state a permissions edit should be
able to reach.

Beside the kind, `Tenant` carries the broker profile the specification asks for:
`legalName` and `defaultExecutionMode` (INTERNAL | EXTERNAL_BROKER — where a new
account under the tenant executes unless the account says otherwise; the mode
exists before the external path does, so nothing pretends a venue is connected
when none is).

## Role groups

The specification names roles the repository already had under other names, and
adds two groups. The keys stay — a rename that touches every row, token and test
buys nothing a display name does not — and `ROLE_ALIASES` maps the
specification's names onto them:

| Specification            | Key            | Group    |
| ------------------------ | -------------- | -------- |
| `TRADING_USER`           | `USER`         | END_USER |
| `BROKER_SUPPORT`         | `SUPPORT`      | BROKER   |
| `BROKER_TRADING_MANAGER` | `RISK_MANAGER` | BROKER   |
| `BROKER_ADMIN`           | `ADMIN`        | BROKER   |

`OPERATOR` and `FINANCE` keep their names and are BROKER-group roles. New in this
phase, with the grants in [permissions.md](./permissions.md):

| Key                    | Group    | In a sentence                                                              |
| ---------------------- | -------- | -------------------------------------------------------------------------- |
| `BROKER_OWNER`         | BROKER   | An administrator plus the firm's own settings                              |
| `BROKER_ANALYST`       | BROKER   | Reads everything in the firm, changes nothing                              |
| `BROKER_DEVELOPER`     | BROKER   | The firm's keys and tokens, and what they need to read                     |
| `PLATFORM_SUPER_ADMIN` | PLATFORM | Runs the platform: brokers, plus everything an administrator may           |
| `PLATFORM_OPERATOR`    | PLATFORM | Creates and manages brokers, intervenes on the desk; makes no money appear |
| `PLATFORM_SUPPORT`     | PLATFORM | Reads across the platform, changes nothing                                 |
| `PLATFORM_AUDITOR`     | PLATFORM | Reads everything including the audit and security feeds                    |
| `PLATFORM_DEVELOPER`   | PLATFORM | The platform's own keys and tokens                                         |

**Which tenant seeds which** is `rolesForTenantKind`: a broker seeds END_USER
and BROKER; the platform seeds all three. `seedTenantRoles` reads the tenant's
kind when the caller does not pass it, and the reconcile-at-boot pass
(`RolesService.reconcileWithBuild`) seeds the new roles into every existing
tenant on the first start after this release, the same way every earlier release
added a capability. Roles a tenant of its kind does not seed are **not removed**
if present: a tenant whose kind changed would otherwise lose roles people hold,
silently, at the next boot.

## Who may put someone into a role

Assigning a role and inviting into one are the same decision with a delay in it,
so both go through `RolesService.assertAssignable`. Three refusals:

1. **Not a role this tenant has.** `PLATFORM_SUPER_ADMIN` on a broker's user
   would be a role with no grants — harmless today, a live account waiting for
   the day somebody seeds it.
2. **Above the assigner's group.** Broker staff appoint broker staff and
   traders; only platform staff appoint platform staff. Decided by group rather
   than by comparing grants, because the built-in roles are deliberately _not_
   nested: an administrator cannot pay a withdrawal and finance cannot assign a
   role, and comparing grants would leave nobody able to appoint the finance
   desk at all.
3. **Grants the assigner lacks, when somebody edited them.** A built-in role with
   its shipped grants is a reviewed design. A role somebody has widened is that
   person's design, and the bound that stops an editor widening their own role
   applies: you cannot hand out what you do not hold.

The first-administrator CLI ([deployment.md](./deployment.md)) takes
`--role ADMIN|PLATFORM_SUPER_ADMIN`, refuses the platform role on a BROKER
tenant, and refuses any role the tenant has not seeded yet.

## Creating a broker

`POST /admin/brokers` — `tenants.manage`, session-only, platform tenant only —
does four things and returns the one that cannot be fetched again:

1. Creates the tenant (kind BROKER, slug and hostname unique across the table).
2. Seeds its roles, **inside the new tenant's scope**, so the rows carry its id
   and its RLS policy accepts them.
3. Mints a single-use invitation in the new tenant that **grants `BROKER_OWNER`**
   to whoever registers with it, valid 72 hours by default. The invitation's
   creator is the platform actor — the user table does not scope invitations,
   and the broker's own audit log should say who set the firm up.
4. Writes `tenant.created` to the **platform's** audit log with the invitation's
   fingerprint, never its code.

The response carries the invitation code. The console shows it once, in
component state, with a copy button; the server keeps a hash and a fingerprint.
The owner registers on the broker's hostname (or, before one is set, on the
default host with `TENANT_HOST_STRICT=false`) with that code, and arrives as the
firm's first `BROKER_OWNER`.

A role-granting invitation is bounded by the minter's role as above. Creating a
broker is the one place that bound is set aside, on purpose: the authority to
appoint a firm's first owner _is_ `tenants.manage`, checked at the door, and a
broker with no owner is a broker nobody can run. The mint is told its minter is
the owner-equivalent; the platform's audit record names who really did it.

`POST /admin/brokers/:id/status` suspends, reinstates or closes a broker with a
reason. Suspending one stops its hostname being served at the next request —
the resolver's caches are dropped — and stops background work entering it
(`TenantResolver.byId` returns null for a suspended tenant). A closed broker
stays closed.

## Invitations that carry a role

`POST /admin/invites` accepts `grantsRole`. Whoever redeems the code is created
in that role instead of `USER`, `USER_REGISTERED` records the role, and the
invitation list shows it. It is how a firm's first owner is appointed and how
an administrator brings in a colleague without a second step.

One behaviour changed to make this work: a code offered on an **open** tenant is
now claimed rather than ignored, and a wrong one is refused there too. An
invitation is the only way a registration can arrive in a role other than
`USER`, and a firm's first owner is created this way whatever the tenant's
registration mode; and someone who typed a code expected it to count.

## Verified by breaking it

Eight integration tests create brokers, redeem the owner invitation inside the
new tenant, and try the platform's routes from a broker tenant and from no
tenant. Three mutations were made and watched: dropping the platform check on
`create` (caught by "refuses every operation from a broker tenant"), dropping the
group rule from `assertAssignable` (caught in both the admin and the invitation
suites), and treating an edited role as shipped (caught in both). The CLI's
platform-only refusal has its own test, and the harness's second-tenant helper
was found seeding roles into the wrong tenant's scope on the way — fixed, and the
seed now needs a scope for the tenant it seeds.
