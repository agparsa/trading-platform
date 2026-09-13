# Database Audit

**Audited:** `prisma/schema.prisma` at commit `76fd42a`, 1,293 lines including
the seed. Nine migrations applied, from `20260821101947_init` to
`20260829133852_reconciliation_and_notifications`.

---

## 1. Inventory

29 models, 18 enums, 35 indexes, 16 unique constraints, 29 relations.

```
Identity        User · TotpRecoveryCode · RefreshToken
Accounts        Account · AccountSettings · BalanceLedger · AccountSnapshot
Instruments     Symbol · SymbolSpec · MarketSession · Candle
Trading         Order · OrderEvent · Position · PositionEvent · Execution · Trade
Risk            RiskRuleConfig · RiskEvent
Oversight       AuditLog · IntegritySignal · IntegritySignalEvent
                ReconciliationRun · ReconciliationFinding
Delegation      MasterAccount · MasterAccountLink
Platform        SystemSetting · IdempotencyKey · Notification
```

## 2. Money

**Zero floating-point columns.** Verified two ways: by grep (`Float`, `@db.Real`,
`@db.DoublePrecision` — no matches) and by `pnpm check:schema`, which is a script
(`scripts/assert-no-float-columns.ts`) that queries `information_schema` on a live
database and fails the build if a real or double-precision column appears. The
grep can be defeated by a type alias; the script cannot, because it asks Postgres
what the column actually is.

Money is `Decimal(28, 10)`; volumes, rates and a few derived figures use
narrower shapes. `pnpm check:schema` prints the full breakdown, which is where
to look rather than here — this paragraph used to say "44 columns are
`Decimal(28, 10)`" and by September there were 54, plus four shapes it did not
mention. On the wire, money is a decimal **string**, so JSON never turns it
back into a float. In application code it is `decimal.js`.

The columns are the half this document is about, and that half holds. The other
half — arithmetic — is `scripts/no-float-money.test.ts`, added in September
after four places were found doing money in binary. See `TRADING_AUDIT.md` for
what they were and for the two exceptions that remain, each with its reason.

## 3. Time

60 timestamp columns, every one `Timestamptz(6)`. There is no naive timestamp in
the schema. Everything is stored in UTC and the timezone is explicit in the
column type rather than assumed by convention.

## 4. Identifiers

68 UUID columns. Every model's primary key is a UUID; there is no sequential
integer key anywhere, so nothing sequential can leak through an API. Accounts
additionally carry a human-facing `number` (`TP-100284`) which is unique and is
what people quote to support — a separate, deliberate concept from the key.

## 5. Referential integrity

| `onDelete` | Count | Where                                                                                               |
| ---------- | ----- | --------------------------------------------------------------------------------------------------- |
| `Restrict` | 17    | Anything financial. An account with a ledger cannot be deleted.                                     |
| `Cascade`  | 10    | Rows that only exist as children of a user or account — sessions, recovery codes, notifications.    |
| `SetNull`  | 2     | `AuditLog.actor` and `Order.position`. Deleting a user must not delete the record of what they did. |

The pattern is coherent: financial history is undeletable, personal detritus
cascades, and the audit trail survives the deletion of its subject.

## 6. The ledger

`BalanceLedger` is append-only by design and by discipline: no code path issues
an `UPDATE` or `DELETE` against it. Each row carries a `balanceAfter`, so the
running balance is auditable row by row rather than recomputed and hoped over.
`Account.balance` is a cached projection of it, and a scheduled reconciliation
job compares the two — the ledger is the source of truth and the job says so.

Each row can carry an `idempotencyKey`, unique, which is what stops a retried
webhook or a re-run job from double-crediting.

**This is the best-designed part of the schema.**

## 7. Concurrency

Three mechanisms, used deliberately and in different places:

- `SELECT … FOR UPDATE` on the account row for anything that moves money, so
  concurrent trades on one account serialize rather than interleave.
- An optimistic `version` integer on `Account` and `Position`, so a stale write
  is rejected rather than silently applied.
- An explicit `OPEN → CLOSING` status claim on positions, so two simultaneous
  close requests cannot both close the same position.

## 8. Immutability of the audit log

`AuditLog` has no update path in the application. It is written by
`AuditService` and read by the admin console; nothing offers an edit.

**However** — and this is a genuine gap against the specification's requirement
that _"normal administrators must not be able to modify/delete audit logs"_ —
that protection is application-level only. The API's database role owns the
table and can `UPDATE` and `DELETE` it. An administrator with database access,
or an attacker who reaches the database, faces no obstacle.

**Recommendation:** a `REVOKE UPDATE, DELETE ON audit_logs` for the application
role, with inserts allowed. This is a migration and a deployment note, not a
refactor, and it converts a convention into a constraint.

## 9. What the schema is missing

Each of the following was searched for by name. Zero occurrences.

| Model                              | Purpose                   | Blast radius of adding it           |
| ---------------------------------- | ------------------------- | ----------------------------------- |
| `Tenant`                           | The root of multi-tenancy | **Every model above.** See §10.     |
| `Wallet`, `WalletTransaction`      | User-facing funds         | New; touches ledger at the boundary |
| `PaymentIntent`, `PaymentProvider` | Deposits                  | New, self-contained                 |
| `WithdrawalRequest`                | Withdrawals with approval | New; needs KYC + ledger             |
| `KycRecord`, `KycDocument`         | Identity verification     | New, self-contained                 |
| `ApiKey`, `ServiceToken`           | Programmatic access       | New; touches auth guard             |
| `Webhook`, `WebhookDelivery`       | Outbound integration      | New; touches event bus              |
| `PushDevice`                       | FCM / APNs tokens         | New; touches notifications          |
| `NotificationPreference`           | Per-user channel choice   | New; touches notifications          |
| `SecurityEvent`                    | Security Center feed      | Partly derivable from `AuditLog`    |
| `Role`, `PermissionGrant`          | Roles as data             | Replaces compile-time constants     |

## 10. The tenancy problem, stated plainly

> **Resolved in the `multi_tenancy` migration.** What follows is the audit as it
> stood, kept because the reasoning is what the implementation was built to; see
> [multi-tenancy.md](./multi-tenancy.md) for what was actually done and what was
> deliberately left.

**Zero occurrences of `tenantId`, `tenant_id`, or `model Tenant` in the entire
repository.** The platform is single-tenant in a way that is invisible right now
because there is exactly one tenant, and will be expensive later because it is
invisible.

Adding tenancy means:

1. A `Tenant` model.
2. `tenantId` on every owned entity — realistically 20 of the 29 models. `Symbol`,
   `SymbolSpec`, `MarketSession` and `Candle` are arguably global; whether
   instruments are per-tenant is the first product decision to make, and it
   changes the migration.
3. Every unique constraint that is currently global becomes tenant-scoped.
   `User.email` is the sharp one: the same person may be a user of two tenants,
   so `@unique` on email becomes `@@unique([tenantId, email])`. That is a
   behavioural change to login, not just a schema change.
4. Every query in 132 API files gains a tenant predicate — and _not_ by asking
   each author to remember. It must be enforced by a Prisma client extension
   that refuses a query on a tenant-scoped model without a tenant filter, so
   that forgetting is a crash and not a leak.
5. Postgres row-level security as a second line, so that a bug in the extension
   is still contained by the database.
6. The tenant is derived from the authenticated context. Never from a header,
   a body field, or a query parameter. The specification states this and it is
   correct: the moment the client can name its tenant, the boundary is decorative.

**Backfill:** existing rows belong to a single default tenant, which makes the
data migration trivial. The code migration is not trivial. This is why it is
Phase 1 of the implementation plan rather than a later convenience — every week
of new code written without it is another week of code to retrofit.

## 11. Risks

| Risk                                                          | Severity   | Note                                                  |
| ------------------------------------------------------------- | ---------- | ----------------------------------------------------- |
| No tenancy                                                    | **High**   | Cost grows with every commit                          |
| Audit log deletable at the database level                     | **Medium** | One migration fixes it                                |
| No partitioning on `Candle` or `AuditLog`                     | **Medium** | Both grow without bound; fine now, not at scale       |
| No archival policy for `Trade`, `OrderEvent`, `PositionEvent` | **Low**    | Correct to keep; needs a plan before it is a problem  |
| `Account.balance` can drift from the ledger                   | **Low**    | Detected by reconciliation, which is the right answer |
