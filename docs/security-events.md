# Security events

The feed a person reads to answer "was that me?", and the feed a firm reads to
answer "is somebody working on us?". Sign-ins and failed sign-ins, second-factor
failures, new devices, sessions ended, passwords changed and reset, two-factor
turned on and off, recovery codes used, keys and tokens minted and revoked, roles
assigned, suspensions and unlocks.

## Derived, not duplicated

Every one of those things was already in the audit log. What was missing was a
way for the person it concerns to see it — `audit.read` is a staff capability —
and a way for staff to see only the security-relevant slice, by person, by
severity, by address.

So `security_events` is a **projection of `audit_logs`**, written by
`AuditService` itself: when the action it is recording is one of the kinds in
`SECURITY_KINDS`, it writes the security event beside the audit row, on the same
client, in the same transaction when it has one. There is no second call site to
forget and no second table to drift. An action not in the table is audited and
not fed; adding a kind is one line in the table and one value in the enum, and
a test fails if the two disagree.

Each event carries: whose it is (`userId`), the kind and a severity, who caused
it (`actorId`, `actorType`), the request id, address and user agent, the audit
row's redacted `after` payload as `details`, and the audit row's id for the
investigator who wants the rest.

**Whose it is** is decided per kind. A sign-in names the user it was for — the
audit row's resource — even when the actor is the same person, and a suspension
names the person suspended, not the administrator. A minted key names its
holder — the actor — because the audit row's resource is the key. `byOther` on
the view is "the actor is not the subject": staff, or the platform.

**Severity** is what the feed sorts and colours by. INFO is routine and expected
(a sign-in, a sign-out). NOTICE is a change the person should recognise as theirs
(a new key, a changed password, a role change). WARNING is what an attacker
leaves behind (a failed sign-in, a new device, a second factor turned off, a
recovery code used, a suspension).

## Append-only, tenant-scoped

The table refuses UPDATE, DELETE and TRUNCATE by trigger, exactly as the audit
log does, and for the same reason: a security feed that a compromised
administrator account could tidy is a feed that says nothing. It carries
row-level security like every scoped table, and `SecurityEvent` is in
`TENANT_SCOPED_MODELS` — which the tenancy package's own test enforces, and
which this phase re-learned the hard way when a stale build of that package let
one tenant's feed show another's failed sign-in until the package was rebuilt.

## Reading it

`GET /security/events` — self-service — is the person's own feed, newest first,
up to 200 with a `before` cursor. Self-service means a credential the person
minted may not read it: the feed is where a stolen key's use would show up, and
the key must not be able to watch for that. The Security page shows it under
the sessions and keys.

`GET /admin/security/events` — `security.read`, held by support, risk,
administration, every platform role and the analyst — is the firm's feed,
filtered by person, kind, severity, address and time, capped at 500.
`GET /admin/security/summary` counts by kind and severity since a time, for the
console's filter vocabulary. `/admin/security` in the console shows both.

## What it is not, yet

It records; it does not judge. "Five failed sign-ins from one address in a
minute" is a query over this table, and phase 10 (anti-abuse) is where that
query becomes a `FraudSignal` with a review queue — per the specification,
never an automatic punishment. The lockout that already exists after repeated
failures is the auth service's own and predates this feed.

## Verified

Seven integration tests drive `AuditService` directly — the one writer — and
check attribution, redaction, the request id from the request scope, tenant
isolation of the firm's feed, rollback inside a failed transaction, and the
three refusals at the database. One test pins the mapping to the enum in both
directions.
