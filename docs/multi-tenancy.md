# Multi-tenancy

The design, and the reasoning behind each decision that was not forced.

Written before the implementation, because the schema encodes these choices and
changing one afterwards means another migration across thirty-one models.

---

## 1. The rule everything else serves

> **Tenant identity is derived from the authenticated context. Never from the
> request.**

Not a header, not a body field, not a query parameter, not a path segment. The
moment a client can name its own tenant, the boundary is decorative — an
attacker simply names the tenant they want.

There is exactly one place a tenant enters the system from outside: the
hostname, and only for requests that have no authentication yet (sign-in,
registration, password reset). Everything else reads it from the token.

## 2. What is tenant-scoped and what is not

**Global — one copy, shared by every tenant:**

```
Symbol · SymbolSpec · MarketSession · Candle
```

An instrument is a fact about the world. `XAUUSD` has a contract size of 100
whoever is trading it, its sessions are the market's, and its price history is
one history. Copying that per tenant would mean N simulators printing N
different gold prices, which is not multi-tenancy but N platforms.

`SymbolSpec` holds the contract specification — tick size, contract size,
precision — and the platform's default commercial terms. **`TenantSymbolTerms`
holds a firm's own**, and it is what the admin console writes.

That distinction started as a limitation and turned out to be a hole. Before it
existed, `POST /admin/instruments/:code/terms` wrote a global row, so one firm's
administrator raising a margin rate would put another firm's accounts into
margin call without anybody touching them. A cross-tenant _write_ that survived
the first pass of the isolation work because it did not look like one: no id was
guessed, no filter was missing, and the route was correctly permission-checked.

Every column on `TenantSymbolTerms` is nullable, and null means "the platform's
value". A tenant that overrides only its margin rate keeps following the
platform's commission when that changes. The other reading — freeze the rest at
whatever they were the day the row was written — would mean one edit silently
detaches a firm from every future correction, and nobody would notice for years.

`enabled` is an AND, not an override: a firm may decline an instrument the
platform offers, and may not offer one the platform has withdrawn. A withdrawn
instrument is withdrawn because it cannot be priced or settled, and a firm's
wish to trade it does not change that.

**Tenant-scoped — everything else, twenty-six models:**

```
User · TotpRecoveryCode · RefreshToken · InviteCode · InviteRedemption
Account · AccountSettings · BalanceLedger · AccountSnapshot
Order · OrderEvent · Position · PositionEvent · Execution · Trade
RiskRuleConfig · RiskEvent · IntegritySignal · IntegritySignalEvent
ReconciliationRun · ReconciliationFinding
MasterAccount · MasterAccountLink
AuditLog · IdempotencyKey · Notification
```

**`SystemSetting` is the one hybrid.** Its `tenantId` is nullable, and null
means the whole platform. The kill switch is why: an operator must be able to
halt one tenant, and the platform operator must be able to halt everything. A
tenant-scoped setting falls back to the platform-wide one when it has no row of
its own.

## 3. `tenantId` is denormalised onto every scoped row

`OrderEvent` belongs to an `Order`, which belongs to an `Account`, which belongs
to a `User`, which belongs to a `Tenant`. The tenant is derivable by joining
four tables — and derivable is not the same as enforceable.

Two reasons to store it directly:

**Row-level security needs it local.** An RLS policy is a predicate on the row.
A policy that has to join to find its tenant is a policy that runs on every read
of every row, and one that is easy to write subtly wrong.

**Application queries do not always start at the root.** `orderEvent.findMany({
where: { orderId } })` is a legitimate query, and it must be scopeable without
the caller remembering to join.

The cost is that the value must be set correctly on insert, which is what the
client extension in §6 exists to guarantee.

## 4. `User.email` becomes unique per tenant

Today `email` is globally unique. That is wrong the moment two tenants exist:
the same person may hold an account with two firms, and the second one to try is
told their address is taken by a platform that will not say by whom.

```prisma
@@unique([tenantId, email])
```

**This changes sign-in, not just the schema.** Login must resolve the tenant
_before_ it resolves the user, because `email` alone no longer identifies
anybody.

Resolution order for an unauthenticated request:

1. The `Host` header, matched against `Tenant.primaryHost`.
2. Failing that, the platform's default tenant.

The fallback is what keeps today's single-tenant deployment working unchanged.
It is also the thing to remove once a second tenant exists — a fallback that
silently picks a tenant is fine when there is one and dangerous when there are
two. There is a configuration flag for exactly that: `TENANT_HOST_STRICT`.

Other uniques that become tenant-scoped for the same reason: `Account.number`,
`RiskRuleConfig.name`, `IdempotencyKey.[scope, key]`, `MasterAccount` names.

Uniques that stay global, and why: `RefreshToken.tokenHash`,
`InviteCode.codeHash`, `User.emailVerificationTokenHash`,
`User.passwordResetTokenHash`. These are high-entropy secrets. Scoping them per
tenant would mean a collision across tenants is possible in principle and
tolerated in practice, and it buys nothing — a global unique on a random 256-bit
value is free.

## 5. How the tenant reaches the code

An `AsyncLocalStorage` holds the current tenant for the duration of a request or
a job. It lives in `@tp/tenancy` — a package rather than in the API, because the
worker needs the same scope and the same extension, and two copies of an
isolation boundary is one copy that will be a version behind.

It is set in exactly four places and nowhere else:

- **The tenant middleware**, from the hostname, before anything is authenticated.
- **The auth guard** checks the `tid` claim against it and refuses a mismatch.
- **The realtime gateway**, on connection, making the same check on the
  handshake — a socket is otherwise the one door with no middleware in front.
- **The worker**, per tenant as it iterates. Its sweeps read across tenants and
  say so with `withoutTenantScope(reason)`; everything it _writes_ runs inside
  `withTenant` for the row's own tenant, so a bug in a posting path cannot put
  one firm's charge on another's ledger.

The token carries the tenant. It is signed, so it cannot be edited; it is
minted at login from the user's own row, so it cannot be chosen.

**The WebSocket gateway joins tenant-namespaced rooms.** A subscription checks
the tenant before it checks the account, because checking the account first
means a not-found for an account in another tenant confirms that account does
not exist _here_ — which is information, if the id was guessed from somewhere
else.

## 6. Enforcement, in two layers, because one is not enough

### Layer one: a Prisma client extension

Every operation on a tenant-scoped model passes through an extension that:

- **injects** `tenantId` into `where` on reads and into `data` on writes, from
  the ambient context;
- **throws** when there is no ambient tenant and the caller has not explicitly
  said they want to cross tenants.

Injection rather than validation, deliberately. Requiring every call site to
pass `tenantId` means the failure mode is _forgetting_, and a forgotten filter
is a leak that no test will notice because the test has one tenant. Injecting it
means the failure mode is _the wrong tenant_, which is a crash.

The escape hatch is `withoutTenantScope(reason, fn)`. It is explicit, it takes a
reason, and it is greppable — reconciliation across all tenants, the login
lookup that has not yet resolved a user, and migrations are the only legitimate
callers.

#### What the extension does **not** reach: a nested `include`

It rewrites the **top-level** query. A relation pulled in with `include` or a
nested `select` is filtered by its foreign key alone, so a child row misfiled
under another tenant comes back with its parent:

```ts
// Narrowed: the extension adds tenantId to this where.
prisma.brokerConnection.findFirst({ where: { id } });

// NOT narrowed: `credentials` is filtered by connectionId and nothing else.
prisma.brokerConnection.findFirst({ id, include: { credentials: true } });

// Correct: name the tenant on the relation too.
prisma.brokerConnection.findFirst({
  where: { id },
  include: { credentials: { where: { tenantId: requireTenantId() } } },
});
```

Row-level security would catch it at the database, except that the application
role is exempt from its own policies (§6, layer two, and §9). So the rule is
the code's: **an `include` across a tenant-scoped relation names its tenant.**

This was found by a test that planted exactly such a row — a credential filed
under one firm on another firm's connection — and watched the worker open it.
`instruments.service.ts` had the pattern right already; the broker services
follow it, and a mutation that removes it fails
`broker-health.test.ts`. Where a child is only ever written in the same
transaction as its parent the risk is theoretical, but the rule costs one
clause and the exception costs an incident.

### Layer two: Postgres row-level security

Every tenant-scoped table carries a policy comparing `tenant_id` to
`current_tenant_id()`, which reads the `app.tenant_id` session setting and
returns NULL when it has never been set. **NULL matches no row**, so a
connection that forgets to set it reads nothing rather than everything — the
failure direction that does not leak.

This exists because layer one is code, and code has bugs. Three it cannot cover:

- `$queryRaw` does not pass through Prisma extensions at all;
- a nested `connect` takes a strict unique input that will not accept an extra
  column, so the extension cannot narrow it;
- a model added to the schema and forgotten in `TENANT_SCOPED_MODELS` is
  silently unprotected — which is why a test reads the schema and fails the
  build if one is missing.

#### What is true today, stated exactly

The policies exist, RLS is enabled, and **it constrains the application** — but
only when the deployment gives the application a second database role. That is
one line of configuration, and without it the second layer is decoration.

PostgreSQL exempts a table's owner from its own policies. `DATABASE_URL` is the
owner — migrations need it to be. So a deployment where the application connects
as the owner has policies that constrain a reporting user, an analyst's psql
session and a service granted SELECT, and constrain the application not at all.

`DATABASE_URL_TENANT` is what changes that. It points at a login role created by
`pnpm db:roles` that owns nothing, holds SELECT/INSERT/UPDATE/DELETE and no
CREATE, and is `NOBYPASSRLS`. Tenant traffic runs on it. Policies apply.

#### How the tenant reaches a pooled connection

This is the part that used to look impossible, and the note in the
`tenant_row_level_security` migration says so at length. It was wrong, and it is
left in place because rewriting an applied migration is worse than a note that
records what was believed at the time.

The two obvious mechanisms are both bad:

- `set_config(..., true)` is transaction-local, so every read would need a
  transaction wrapped round it;
- `SET` outside a transaction is session-level, and the next request gets
  whichever pooled connection is free — a tenant would leak into someone else's
  queries, which is worse than no second layer at all.

The third is a connection that is _born_ knowing its tenant. PostgreSQL accepts
`options` in the startup packet and Prisma passes the parameter through:

```
postgresql://…/trading?schema=public&options=-c%20app.tenant_id=<uuid>
```

Measured, same read, local socket:

| Mechanism                         |    p50 |    p95 |
| --------------------------------- | -----: | -----: |
| No policies at all (the floor)    | 0.72ms | 1.21ms |
| Tenant bound to the connection    | 0.54ms | 0.86ms |
| `set_config` inside a transaction | 1.85ms | 2.87ms |

The cost is that a connection belongs to one tenant for its life, so there is a
pool per tenant. `TenantClientRegistry` keeps them, capped by
`DATABASE_TENANT_POOLS`, evicting the least recently used — and an evicted pool
is removed from the map immediately but closed only after a drain delay, because
`$disconnect()` does not wait for work in flight. A query running when it is
called fails, with an empty error message. That was measured too.

`PrismaService` is a proxy over the registry, so `this.prisma.order.findMany()`
reads exactly as it did; what changed is which connection answers it.

#### Three connections, and why the default is the deaf one

| Scope                        | Role         | Sees                     |
| ---------------------------- | ------------ | ------------------------ |
| `withTenant(ctx)`            | unprivileged | that tenant's rows       |
| no scope                     | unprivileged | **nothing**              |
| `withoutTenantScope(reason)` | owner        | everything, deliberately |

The middle row is the one that matters. Work with no scope gets a connection with
no `app.tenant_id`, `current_tenant_id()` is NULL, and NULL matches no row — so
forgetting to open a scope reads nothing rather than everything. If a missing
scope fell through to the owner instead, forgetting would silently disable both
layers at once and nothing would look wrong.

#### Why not FORCE

`FORCE ROW LEVEL SECURITY` would subject the owner to the policies as well. The
owner's exemption is not an oversight; it is the escape hatch. The sign-in lookup
has to find a user before it knows their tenant, and the reconciliation sweep has
to list which tenants exist. Both run through `withoutTenantScope`, on the owner
connection, precisely because it can see across.

Forcing the policies would remove that mechanism rather than tighten one. The
alternative — granting `BYPASSRLS` to the owner — is the same exemption spelled
with more moving parts and a superuser.

#### The one thing that cannot be checked by reading code

Whether the role actually connected as is a role the policies apply to.
Ownership, superuser and a missing policy all produce the same symptom:
everything works, and the second layer quietly is not there.

So it is measured. At boot, the API and the worker each ask their unprivileged
connection to count rows in `users` with no tenant bound. The correct answer is
zero. Any other answer means the connection is exempt.

- `DATABASE_URL_TENANT` set and the probe fails → **the process refuses to
  start**. A connection string that claims isolation and does not have it is the
  one people stop checking.
- `DATABASE_URL_TENANT` unset → the documented single-role posture, reported
  rather than merely warned about.
- `users` empty → reported as unknown, not as success. A check that reads "fine"
  on an empty database reads "fine" on a fresh deployment, which is exactly when
  somebody would believe it.

### Asked again, and reported somewhere a person will see it

The three lines above were all true and the reading was still not obtainable,
for two reasons that only show up together.

**The probe ran once, at boot.** It reads `users`, chosen because that table "is
never empty in a running deployment" — and it is empty at exactly one moment, a
fresh install starting for the first time, which was the only moment anything
asked. A new deployment answered _unknown_, somebody registered a minute later,
and nothing asked again. The refusal promised above could not fire on the
deployment where getting it wrong costs the most. Both processes now keep asking
while the answer is unknown, and stop the moment it is definite: the API from
the metrics refresh, the worker from its sweep. Ownership and role membership do
not change under a running process, so a settled answer is kept.

**And the answer went to one log line.** On the default deployment that line is
a warning nobody is meant to act on, which is how a reader learns to skip it.
It is now:

| Where                    | What it says                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/tenancy`    | `enforced` and `configured`, and nothing else — the role name and the probe's reason are database internals and this route is public                                                                     |
| `GET /ready`             | **down** only on the pair the platform promises to refuse: asked for and absent. Every other state is up                                                                                                 |
| `tp_tenant_isolation`    | `1` enforced, `0` not, `-1` while there is nothing to prove it with. Labelled `configured` — whether `DATABASE_URL_TENANT` is set — so that `0` asked for can be alerted on and `0` not asked for cannot |
| `pnpm verify:production` | prints which posture this deployment is running, and fails on that same pair                                                                                                                             |

**Unknown is up, deliberately.** A two-role deployment on a fresh database
cannot prove the policies bite until a row exists, and taking readiness down
there would stop the platform serving the request that creates its first user —
so it could never become provable. The state is published and the probe keeps
asking.

The worker probes separately from the API on purpose: they read the same database
but are configured, deployed and restarted independently, so "the API said it was
fine" is not evidence about the worker. It has no health endpoint to publish to,
so its late answer is a log line — at `error`, not `warn`, when the operator
asked for isolation and it is absent.

Neither layer is sufficient alone and that is the point. A single mechanism that
is "obviously correct" is a mechanism nobody checks.

### Deploying it

```bash
pnpm db:roles            # creates trading_app, prints DATABASE_URL_TENANT
# put that line in .env, with the password
pnpm db:roles            # again after any migration that adds a table
```

The second run is belt and braces: `ALTER DEFAULT PRIVILEGES` already covers
tables a later migration creates, but running the script is the version that also
verifies rather than assuming.

### A trap worth writing down: Prisma's lazy thenables

`prisma.account.findMany()` builds a request and starts nothing. The query runs
when something calls `.then` on it.

So this is wrong, and wrong in a way that is almost invisible:

```ts
storage.run(tenant, () => prisma.account.findMany()); // ✗
```

`run` calls the callback synchronously, gets back an un-started thenable, and
returns — restoring the previous scope. The caller then awaits it, and _that_ is
when the query executes: outside the scope it was supposed to be inside.

`withTenant` awaits inside the run for exactly this reason. The symptom was an
isolation test in which one tenant's read returned another's row, while a probe
of the same mechanism written with an `async` callback passed.

## 6a. Background work has no tenant, and every path that runs on a timer forgot

The guard refuses any query made with no tenant in scope. A request always has
one, so the guard is invisible to every handler — and to every test that drives
one, because the harness enters a scope before each case.

A timer does not. Nor does a tick handler, nor a socket refresh. When isolation
went live, those paths began throwing, and the platform went on serving requests
perfectly while:

| What stopped                    | Consequence                                                 |
| ------------------------------- | ----------------------------------------------------------- |
| the trigger engine's tick sweep | **stop-losses and take-profits did not fire**               |
| the stop-out sweep              | accounts past their stop-out level were not liquidated      |
| the realtime drain              | connected terminals stopped receiving valuations            |
| the snapshot pass               | no account history was recorded                             |
| `refreshSockets`                | **revoked account access was never taken off live sockets** |
| platform metrics                | operator gauges froze at their last values                  |

12,296 failures on the ingest instance, in one deployment's uptime, and nothing
in the test suite noticed.

### The shape every one of them now has

Two different questions, answered two different ways:

- **Finding the work** genuinely spans tenants. A price is a fact about the
  market, and every firm holding that instrument is affected. Those discovery
  queries are wrapped in `withoutTenantScope(reason)` and each carries its
  reason, so a reviewer grepping for crossings finds them with the argument
  attached. They select `tenantId` alongside whatever else they need.
- **Doing the work** never spans tenants. Closing a position writes a ledger
  entry, sends a notification and moves money — all of it belongs to exactly one
  firm. So each row's work is re-entered with `withTenant(...)`, using
  `TenantResolver.byId`, which caches and returns null for a tenant that is
  suspended or gone. Background work skips such a tenant rather than throwing:
  there is nobody to refuse.

`RealtimeService` needs no lookup at all — a socket carries its tenant's id and
slug from connection time, checked against the token's `tid` against the host, so
the drain groups its listeners by tenant from memory.

The alternative — running these sweeps unscoped throughout — was one line and
would have made the tick path the one place on the platform where **writes**
routinely happen with no tenant. That is exactly the property the guard exists
to prevent.

### The test that would have caught it

`background-scope.test.ts` sweeps the source for files that start background
work _and_ touch the database, and requires each to name a tenant somewhere.
Static rather than behavioural, deliberately: a behavioural version would have to
be handed a list of background services, and the ones worth catching are exactly
the ones nobody remembers to add to such a list — so the check has to find its
own subjects. Exemptions are a named list with a reason each, so adding one is a
decision a reviewer can argue with.

It is not a proof. A file could open a scope for one query and forget another.
It is the difference between a service that has thought about the question and
one that has not.

### The worker: the job that had thought about it, and still forgot one write

The reconciliation job was the model citizen — `withoutTenantScope` with a
reason for the sweep, `withTenant` for each account's checking — and it never
ran in production. Its _run row_, written before the sweep and closed after it,
carried a `tenantId` in its data and was written in no scope at all. The
extension refused it, as it should; the queue retried five times an hour; the
console showed no run since the day tenancy went live. The static sweep could
not see it: the file named a tenant, several times.

What hid it was the test harness. `beforeEach` enters a tenant so that ordinary
tests can write rows, so every test of the job drove it from _inside_ a scope
it had never opened. A queue hands a job nothing.

So `@tp/tenancy` gained `outsideAnyScope(fn)` — `AsyncLocalStorage.exit`, the
state a process entry point actually starts in — and `jobs.test.ts` drives
every entry point the registry attaches from there. It cannot widen anything:
outside a scope the extension refuses every scoped query, so the only thing it
can do to correct code is nothing. Three of the new tests failed against the
old service; the swap and maintenance jobs passed, because they had been right.

## 7. Migration

Every existing row belongs to one default tenant, created by the migration.
Backfill is a single `UPDATE` per table with a constant, which is why the data
migration is trivial and the code migration is not.

`TENANT_DEFAULT_SLUG` names it. Nothing about today's behaviour changes: one
tenant, resolved by fallback, with the same data in it.

## 8. What "isolation" is tested to mean

Eighteen integration tests across two files prove layer one, eight more in
`rls-enforcement.test.ts` prove layer two from a role the policies apply to —
including the two things layer one explicitly cannot close, a raw cross-tenant
read and a nested `connect` — and one adversarial probe in
`pnpm pentest` creates a second tenant with its own hostname, registers a
user into it, and then tries every way of reaching the first tenant's data.

**Where an id is involved the answer must be not-found, not forbidden.** A
forbidden confirms the resource exists, which tells an attacker their guessed id
was right and turns an isolation boundary into an enumeration oracle. That is
the whole difference between "you may not see this" and "there is nothing here".

### The probe that nearly proved nothing

The first version of the cross-tenant probe passed with the tenant filter
switched off.

Everything it checked — a trader reading another account, placing an order on
one — was _already_ refused by the per-user ownership checks that predate
tenancy. The probe was measuring the old boundary and reporting on the new one.
Disabling the filter and re-running is what exposed it.

An **administrator** is where the two come apart. `/admin/users` and
`/admin/accounts` are deliberately not user-scoped: an administrator is meant to
see everybody — everybody in their own tenant, and nothing at all of anyone
else's, which only the tenant filter enforces. The probe now promotes the second
tenant's user to `ADMIN` and asserts the first tenant's users, accounts and
audit trail are absent. With the filter disabled that probe reports a breach,
which is how it was checked.

There is a general lesson in it: a security test that passes is worth nothing
until the thing it guards has been broken and the test has been watched to fail.

## 8a. Two kinds of tenant

`Tenant.kind` is PLATFORM for the one tenant that operates the deployment and
BROKER for every other. The platform creates brokers (`/admin/brokers`), seeds
their roles inside their own scope, and mints the invitation their first owner
registers with; a broker's staff cannot reach any of that, by capability and by
a check on the kind of tenant in scope that no permissions edit can change.
`TenantContext` carries the kind when the resolver set it. [brokers.md](./brokers.md)
has the whole of it.

## 9. What is not done

Recorded here rather than implied to be finished.

- **RLS is not forced**, so the application role is exempt. §6 has the reasoning
  and the two ways to finish it.
- **Nothing surfaces a tenant's terms to its traders yet.** The engine charges
  them correctly and the admin console shows them; there is no customer-facing
  contract-specification screen.
- **A platform-wide kill switch cannot be set through the API.** The row is read
  and honoured; nothing writes it, because halting every firm should not sit
  behind the same permission as halting one's own.
- **The instrument cache is process-wide.** A tenant's terms are resolved into
  it at load and refreshed on change, which keeps `require()` a map lookup on
  the hottest path in the system. The cost is that a change is visible to the
  process that made it immediately and to any other API instance on its next
  reload.
