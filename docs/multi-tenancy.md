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

The policies exist and RLS is enabled. It is **not** `FORCE`d, and that is a
decision rather than an omission.

Postgres exempts a table's owner from its own policies unless FORCE is used, and
here the application role owns its tables. So today the policies constrain every
role _except_ the application: a reporting user, an analyst's psql session, a
service granted SELECT. That was verified rather than assumed — a role with
SELECT and no `app.tenant_id` set reads **zero** rows from `users`; set the
variable and it reads exactly that tenant's.

Forcing it needs something the migration cannot provide. The application must
set `app.tenant_id` on the connection for every statement, and Prisma runs most
reads outside an explicit transaction on a pooled connection, where a
transaction-local setting has nowhere to live. Making that work means either
routing every query through a transaction — three round trips where there was
one, on the order path — or moving to a driver adapter that can set the variable
when a connection is checked out.

Turning FORCE on before that plumbing exists would not tighten anything. It
would make every query return zero rows: an outage wearing a security badge.

**So layer two is armed and covers every role but one.** Finishing it is a named
item in the implementation plan, and the deployment change that makes it bite
immediately — running the application as a role that does not own its tables —
is the same one `security.md` recommends for the audit log.

Neither layer is sufficient alone and that is the point. A single mechanism that
is "obviously correct" is a mechanism nobody checks.

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

## 7. Migration

Every existing row belongs to one default tenant, created by the migration.
Backfill is a single `UPDATE` per table with a constant, which is why the data
migration is trivial and the code migration is not.

`TENANT_DEFAULT_SLUG` names it. Nothing about today's behaviour changes: one
tenant, resolved by fallback, with the same data in it.

## 8. What "isolation" is tested to mean

Eighteen integration tests across two files, and one adversarial probe in
`pnpm pentest` that creates a second tenant with its own hostname, registers a
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
- **Roles are still compile-time constants**, so a tenant cannot define its own.
- **The instrument cache is process-wide.** A tenant's terms are resolved into
  it at load and refreshed on change, which keeps `require()` a map lookup on
  the hottest path in the system. The cost is that a change is visible to the
  process that made it immediately and to any other API instance on its next
  reload.
