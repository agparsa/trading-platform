# Security Audit

**Audited:** commit `76fd42a`. Every control below was located in source before
it was described. Where a control is asserted by a test or a probe, the file is
named so the claim can be checked rather than believed.

---

## 1. Authentication

| Control                 | Implementation                                                              | Verified by                                  |
| ----------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| Password hashing        | Argon2id (`@node-rs/argon2`)                                                | `auth/password.service.ts`                   |
| Plaintext passwords     | Never stored, never logged, never returned                                  | pino `redact` list; `User.passwordHash` only |
| Access tokens           | JWT, short-lived, `type` claim checked                                      | `auth/token.service.ts`                      |
| Refresh tokens          | httpOnly + secure + sameSite cookie, rotated on use, revocable              | `auth/refresh-cookie.ts`                     |
| Refresh reuse detection | A replayed token is rejected                                                | `scripts/pentest.ts:221`                     |
| 2FA                     | TOTP with a sealed secret, one-time step enforcement, hashed recovery codes | `auth/totp.service.ts`                       |
| Account lockout         | Per-account failed-attempt counter, independent of the IP limiter           | `User.failedLoginAttempts`, `lockedUntil`    |
| Email verification      | Single-use token, stored **hashed**                                         | `emailVerificationTokenHash`                 |
| Password reset          | Single-use token, stored **hashed**, expiry enforced                        | `passwordResetTokenHash`                     |

Storing the reset and verification tokens hashed rather than plain is the detail
most implementations get wrong. Here a database leak does not hand the attacker
a working password-reset link.

**The TOTP secret is the one reversible secret in the database.** It has to be —
verifying a six-digit code requires the secret itself. It is sealed with
AES-256-GCM and bound to the row it belongs to, so a secret lifted from one row
cannot be pasted into another. `common/crypto/secret-box.ts`.

## 2. Authorization

Four global guards: `ThrottlerGuard` → `BearerAuthGuard` → `RolesGuard` →
`PermissionsGuard`. Registration is asserted by
`common/guards/permissions-coverage.test.ts`, which exists for a specific
reason: deleting the `APP_GUARD` line would make the API public while every unit
test continued to pass. The test reads `app.module.ts` as text and fails if the
registration is gone.

The backend enforces every permission. The frontend's permission awareness is
presentation only — it hides buttons; it does not decide anything. This matches
the specification's rule.

**Separation of duties is real.** `ADMIN` holds `accounts.adjust` and holds none
of `orders.create`, `positions.close`, `positions.modify` — on any account,
including their own. An administrator can credit an account or they can trade,
never both from one login. `scripts/pentest.ts:682` probes exactly this by
calling the adjustment endpoint as a trader.

## 3. Transport and headers

- `helmet` with `default-src 'none'` and `frame-ancestors 'none'`. The API
  serves JSON, so the strictest possible CSP costs nothing.
- CORS with an explicit origin allow-list from configuration, `credentials: true`,
  and only `X-Request-Id` exposed.
- `crossOriginResourcePolicy: same-site`.
- TLS terminates at the edge; the stack listens on 127.0.0.1 only.

## 4. Input validation

One validation library for the whole platform: Zod. Request DTOs, the
environment contract and the shared wire types are all Zod schemas, so a rule
about a price format is written once instead of once per layer.
`ZodValidationPipe` is global — an unvalidated body cannot reach a handler by
someone forgetting a decorator, because there is no decorator to forget.

## 5. Logging

pino, structured, with a `redact` list that **removes** rather than masks:
`authorization`, `cookie`, `password`, `currentPassword`, `newPassword`,
`totpCode`, `set-cookie`. Secrets do not reach the aggregator.

## 6. Audit trail

`AuditService` writes an immutable record with actor, action, resource,
before-state, after-state, request id, IP and user agent. Sensitive operations
audit **before and after**, so a change can be reconstructed and reversed.

**Gap against the specification.** The requirement is that _normal
administrators must not be able to modify or delete audit logs_. In this
codebase that is true of the application — nothing offers an edit — but not of
the database: the application's own role holds `UPDATE` and `DELETE` on
`audit_logs`. The protection is a convention, and conventions do not survive an
attacker with a database connection.

**Fix:** a migration issuing `REVOKE UPDATE, DELETE ON audit_logs FROM <app role>`
while leaving `INSERT` and `SELECT`. One migration; converts a convention into a
constraint. Scheduled as Phase 2 of the implementation plan.

## 7. Adversarial testing

`scripts/pentest.ts` — 826 lines, run with `pnpm pentest` against a live API.
It is not a linter; it attacks. The probes, verbatim from their own descriptions:

```
reach a trading endpoint with no token at all
forge an access token by signing it with a guessed secret
strip the signature with alg:none
present the refresh token as if it were an access token
forge a token with the real access secret but the wrong type
replay a refresh token that has already been rotated
grant yourself a role by putting it in a profile update
register with a role of your choosing
pollute Object.prototype through a JSON body
inject SQL through the login email
inject SQL through a path parameter and a query string
find a credential in an ordinary response
make the server describe its own internals in an error
read the server and framework version from the headers
open a position with a negative or absurd volume
reuse an idempotency key with a different order
guess a password until it is found
read every user on the platform with an ordinary trader token
credit an account by calling the adjustment endpoint directly
```

Two of these deserve note because they test the _quality_ of a control rather
than its presence: the brute-force probe fails if "the lockout let the correct
password straight through, so it only delays a guesser", and the adjustment
probe fails if "an administrative ledger entry exists that no administrator
created". Both check the consequence, not the response code.

## 8. Findings

Three of these were fixed immediately after the audit, in the Phase 0 commit that
follows it. Their entries are kept rather than deleted, marked with what changed,
because a findings list that quietly loses its resolved entries teaches a reader
that nothing was ever wrong.

### F-1 — Registration is open on a public domain · **High** · _fixed in code, not yet deployed_

`https://devopss.ir` accepts any registration. 21 accounts from earlier
verification runs (emails matching `ws-`, `iso-`, `diag-`, `@test.invalid`)
remain in the production database.

**Fixed:** `REGISTRATION_MODE` takes `open`, `invite` or `closed`, and the API
**refuses to boot** with `open` under `NODE_ENV=production` unless
`REGISTRATION_ALLOW_OPEN_IN_PRODUCTION=true` says so explicitly. Invitations are
real: 120-bit codes, stored hashed with an eight-character fingerprint, shown
once, single-use by default, claimed atomically. See
[registration.md](./registration.md).

**Still open:** the deployment has not been updated, and the 21 test accounts are
still in the production database. Both need a decision from the operator rather
than a commit.

### F-2 — Audit log is deletable at the database level · **Medium** · _fixed_

`UPDATE`, `DELETE` and `TRUNCATE` on `audit_logs` are now refused by trigger and
raise `42501 insufficient_privilege`. A `REVOKE` alone would not have worked: a
table's owner keeps every privilege regardless of grants, and the application
role owns its tables here, so the revoke would have looked like it worked and
done nothing.

The residual limit is stated rather than papered over — an actor who can run DDL
as the owner can disable the trigger. `security.md` names the two deployment
changes that would close that, neither of which is done.

### F-3 — A write gated by a read permission · **Medium** · _fixed_

`RECONCILIATION_MANAGE` now gates the finding-status write. `RISK_MANAGER` and
`ADMIN` hold it; `OPERATOR` keeps read and can no longer close a finding.

A pentest probe promotes an actor to `OPERATOR`, confirms they can still _list_
findings — otherwise the probe would prove nothing — and confirms the write is
refused. Reverting the permission makes that probe report a breach, which is how
the probe was checked.

### F-4 — No tenant isolation · **High, structural** · _largely fixed_

There is now a `Tenant` model and `tenantId` on 26 owned models, enforced in two
layers: a Prisma extension that injects the tenant into every query and refuses
to run without one, and Postgres row-level security beneath it. The tenant is
derived from the hostname before authentication and from a signed token claim
after, and never from anything else on the request.

Verified rather than asserted: 18 isolation tests, and a pentest probe that
creates a second tenant on its own hostname, promotes its user to `ADMIN` — the
role that is _meant_ to see everybody — and confirms the first tenant's users,
accounts and audit trail are absent. Disabling the tenant filter makes that
probe report a breach.

**Still open:** RLS is enabled but not `FORCE`d, so it constrains every database
role except the application's own, which owns the tables. Closing that needs a
deployment change (a non-owner role) and per-connection tenant plumbing.
`multi-tenancy.md` §6 has the reasoning and §9 the rest of the list.

### F-5 — Roles are compile-time constants · **Low today, High under tenancy**

A new role requires a deployment. Acceptable for one firm; not for a platform
where each tenant defines its own roles.

### F-6 — No API key or service-token mechanism · **Informational**

Nothing to audit yet. When it lands, the specification's rule is explicit and
must be honoured: never store the raw secret, hash it, store a fingerprint for
identification, and show the generated secret exactly once.

### F-7 — Email transport unverified in production · **Informational**

Verification and reset flows are implemented and tested against a fake
transport. Whether mail actually leaves the production host is **UNVERIFIED**.
Verified by triggering a real registration on the deployed host and reading the
transport log.

## 9. What is not a finding

Recorded so they are not re-raised:

- **`ADMIN` cannot trade.** Deliberate. See §2.
- **`/metrics` refuses external requests.** Correct; it is restricted to private
  ranges and returned a refusal from outside during deployment verification.
- **`/symbols` and `/market/*` are not permission-checked.** Instrument
  definitions and quotes are not per-user data. This changes under tenancy.
