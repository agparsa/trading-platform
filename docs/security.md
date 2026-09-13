# Security

## Boot-time refusal

The API validates its entire environment with Zod before the first module loads.
A missing `DATABASE_URL`, a JWT secret shorter than 32 characters, or an
out-of-range port stops the process. A trading server that starts with a weak
secret and discovers it on the first login is not an acceptable failure mode.

Validation errors print **field names only**. Values are secrets.

## Credentials

- Passwords: Argon2id. The plaintext never reaches the database or a log.
- Refresh tokens: only a SHA-256 hash is stored. A database leak yields no usable
  sessions.
- Token rotation: each refresh issues a new token and records `replacedBy`. Reuse
  of an already-rotated token is a theft signal and revokes the whole family.
- 2FA: TOTP (RFC 6238), enforced at sign-in. The shared secret is the one
  reversible secret in the database and is encrypted with AES-256-GCM, bound to
  the row it belongs to. Recovery codes are SHA-256, single-use, and kept after
  use so the event can be answered for. See [two-factor.md](./two-factor.md) and
  [encryption-at-rest.md](./encryption-at-rest.md).

## Transport and headers

`helmet` with a restrictive CSP (`default-src 'none'`, `frame-ancestors 'none'`)
— the API serves JSON only, so it costs nothing. CORS is an explicit allowlist
parsed from `CORS_ORIGINS`; an empty entry is dropped rather than turned into a
wildcard, so a stray comma cannot open the API to every origin.

## Logging

Pino, structured. Redacted and **removed**, not masked:

```
req.headers.authorization
req.headers.cookie
req.body.password / currentPassword / newPassword / totpCode
res.headers["set-cookie"]
```

Health indicators report `error.name`, never `error.message` — a Postgres
connection error message contains the connection string.

## Errors

Stack traces, SQL and driver text never reach a client. An unrecognised exception
is logged server-side in full and returned as `INTERNAL_ERROR` plus a
`requestId`. See [api.md](./api.md).

## Audit

`audit_logs` is append-only: actor, action, resource, before/after state,
request id, IP, user agent. Every sensitive operation writes one — login, order
create/modify/cancel, position close, SL/TP change, account update, admin action.
Before/after payloads are redacted of anything sensitive before being written.

### Append-only means the database refuses, not just the application

Nothing in the API offers a way to edit or delete an audit row. That is a
convention, and a convention holds only for people who are following it. The
requirement is that a normal administrator cannot alter audit records, and the
person the requirement exists for is the one who has reached a database
connection.

So `UPDATE`, `DELETE` and `TRUNCATE` on `audit_logs` are refused by trigger and
raise `42501 insufficient_privilege`. `INSERT` and `SELECT` are unaffected.

A trigger rather than `REVOKE UPDATE, DELETE`, deliberately: a table's owner
keeps every privilege regardless of what is granted, and in most deployments
here the application role owns its tables, so the `REVOKE` would look like it
worked and do nothing. A trigger fires for the owner too. `TRUNCATE` needs a
statement-level trigger of its own because it does not fire row-level ones —
without that it would be the one statement that empties the table while the
other two are refused.

**What this does not claim.** An actor who can run DDL as the table's owner can
`ALTER TABLE audit_logs DISABLE TRIGGER USER` and then do as they like. The
integration harness does exactly that to reset between runs, which is the honest
demonstration of the limit. Closing it properly is a deployment decision, and
there are two ways:

1. **Run the application as a role that does not own its tables.** Grant it
   `INSERT, SELECT` on `audit_logs` and nothing else. Then the `REVOKE` becomes
   load-bearing and the trigger becomes the second line rather than the only one.
2. **Ship audit records to an append-only sink outside this database** — an
   object store with object-lock, or a log service with retention. This is what
   survives an attacker who owns the whole database, and it is the only thing
   that does.

### The same applies to every table that refuses deletion

Eighteen tables now refuse `DELETE` and `TRUNCATE` by trigger: `audit_logs`,
`security_events`, `broker_inbound_events`, `api_keys`, `service_tokens`,
`broker_credentials`, `kyc_documents`, `payment_events`, `resolution_records`,
`wallet_transactions`, `withdrawal_requests`, `balance_ledger`, `trades`,
`executions`, `order_events`, `position_events`, `risk_events` and
`integrity_signal_events`.

Nine of them refused only `DELETE` until `truncate_is_a_deletion_too`. The
statement-level rule is written out two paragraphs above and was applied to
`audit_logs` in August; every append-only migration written afterwards copied
the row-level half and not the statement-level half, so each new table arrived
with a locked front door and an open back one. `TRUNCATE TABLE
withdrawal_requests` emptied it in silence while `DELETE` raised `42501`.

Nothing catches that by reading a migration, because the migration that is
wrong looks exactly like the nine before it. So it is checked against the live
database instead: `append-only-tables.test.ts` asks `pg_trigger` which tables
refuse `DELETE`, fails if any of them permits `TRUNCATE`, and then actually
attempts a `TRUNCATE` on each — because a trigger can be present and still let
the statement through, which is how the venue-evidence one behaved before it
was corrected.

**Neither of the two deployment options above is done here.** Recorded so it is
a known limit rather than an assumed guarantee: everything in this section is
the first line of defence and none of it survives an actor who owns the
database. What it does buy is that a normal administrator, with a normal
connection, cannot quietly alter the record — which is the threat it was
written for.

A test that needs to corrupt one of these tables, to prove a reconciliation
detector fires, goes through `simulatingCorruption` in the test harness. It
takes the guard off for one statement and restores it in a `finally`, and the
name is deliberately conspicuous: grep for it and you have every place in the
repository that deliberately breaks one of these guarantees — today that is one
reconciliation test, plus the two cases that check the helper re-arms. No count
is quoted here on purpose; the grep is the answer, and a number in a document
is the kind of claim this section exists to be sceptical of.

## Rate limiting

Per-bucket limits, tightest on the endpoints that move money. Login is the
tightest of all. See [api.md](./api.md).

## Secrets

`.env` is git-ignored; `.env.example` carries placeholders only and is the file
committed. Deployments inject real values as environment variables or, better,
as files named by `VARIABLE_FILE` — the convention every secrets manager that
delivers files can meet. Which variables, the refusals, and the compose recipe
are in [secrets.md](./secrets.md). Nothing in this repository holds a real
credential.

## Browser sessions

**Implemented in Phase 11.** The access token is held in the page's memory and
sent as a bearer header. The refresh token is issued **only** as a cookie:

| Attribute           | Why                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpOnly`          | No script can read it. This is the point of the design.                                                                                     |
| `SameSite=Strict`   | A cross-site page cannot cause it to be sent, which is the CSRF defence on the one route that authenticates by cookie.                      |
| `Path=/api/v1/auth` | It never rides along on a trading request, so a proxy logging headers on those paths cannot capture it.                                     |
| `Secure`            | In production. Omitted in development, because a Secure cookie is silently never stored over plain http and that looks like a broken login. |

**No response body ever contains a refresh token.** Login and refresh return an
access token and an expiry, and nothing else. That is what makes the `HttpOnly`
flag meaningful: a flag on a cookie whose value was also printed in the JSON
beside it would protect nothing.

Before Phase 11 the token was returned in the body and kept in `sessionStorage`,
where any injected script could take it and mint access tokens for a month. The
change is visible in what the client no longer contains: no storage reads, no
storage writes, and no token threaded through the refresh call.

### The CSRF threat model, stated

Only one endpoint authenticates by cookie: `POST /auth/refresh`. Every other
mutation authenticates with an `Authorization` header, which a browser never
attaches automatically and a cross-site page cannot set — so those endpoints are
not forgeable, and a CSRF token on them would guard nothing.

What could an attacker achieve by forging a refresh? Not theft: CORS prevents
them reading the response, so the new access token never reaches them. They could
force a rotation and log the user out — a nuisance, not a compromise. Against
that, `SameSite=Strict` plus an `Origin` allowlist check is proportionate, and
both are asserted by tests. A double-submit token scheme was considered and not
adopted: it would add a moving part to defend against something the two existing
controls already stop.

A request with **no** `Origin` header is allowed through. That is not a
cross-site form post — it is how non-browser clients and same-origin navigations
arrive — and refusing them would break every API client to defend against
something they cannot do.

### Non-browser clients

`POST /auth/refresh` still accepts a token in the request body. This is not a
hole: the risk being addressed is a _script reading_ the token, and no response
ever hands one out. A client that wants to manage the value itself must read it
from the `Set-Cookie` header, which only a non-browser client can do.

## Sessions and devices

A user can list their live sessions and end any of them. A sign-in from a kind of
device the account has not used before is recorded and emailed to the owner. The
only inputs are the user agent and the IP already stored with each session — no
fingerprinting, no location lookup. See [sessions.md](./sessions.md).

## Authorisation

Roles are enforced as sets of `resource.verb` capabilities, checked in a global
guard on every declared route, with a build-time test that no mutating route can
be added without declaring what it requires. See
[permissions.md](./permissions.md) — including why `ADMIN` deliberately cannot
place an order.

## The penetration checklist

`pnpm pentest` boots the compiled API and attempts 22 attacks against it —
forged tokens, cross-account reads and writes, role escalation, SQL injection,
prototype pollution, credential leakage in responses and errors, absurd order
volumes, idempotency-key reuse, password guessing. An attack that succeeds fails
the run.

The checklist was itself tested by breaking the API four times to see whether the
probes noticed. Two did not, and both gaps are now closed. See
[penetration-checklist.md](./penetration-checklist.md) — including what it
deliberately does not cover, and why a green run does not mean there is nothing
to find.

## Not yet implemented

The admin audit surface is outstanding. It is listed here as the contract later
phases must meet, not as work already done.

## The WebSocket surface

Three things a long-lived connection got wrong, all about authority it acquired
once and then kept.

### CORS was `origin: true`

Which reflects whatever `Origin` the request carried — so any site on the
internet could open an authenticated socket against this API from a logged-in
trader's browser and read their positions, orders and account in real time. The
HTTP side had been on an allowlist since it was written; the socket had not.

It now uses the same `CORS_ORIGINS` allowlist. Read from `process.env` rather
than `ConfigService`, because `@WebSocketGateway` is a decorator and is evaluated
before the container exists. With no allowlist configured, production fails
closed rather than falling back to a wildcard.

### The token outlived the socket

A WebSocket outlives the fifteen-minute access token that opened it. A socket
authenticated at nine o'clock was still streaming private frames at five — past
a session the user may have ended from another device.

The gateway now records the token's `exp` and re-checks every authenticated
socket once a minute. An expired one is **downgraded**, not closed: it keeps
delivering public quotes, which it is still entitled to, while its private
channels go quiet and it has been told why. Closing would be simpler and worse —
the client reconnects immediately with the same dead token and the pair spin.

### The account set was a connect-time snapshot

Resolved once and never again, so a master-account link revoked this morning went
on delivering somebody else's positions until the operator happened to reconnect,
and an account opened after connect delivered nothing at all.

The same pass re-derives it. Removal happens first: authority that has been taken
away must stop being honoured before anything else in the pass can go wrong.

### Inbound messages are rate-limited

There was no limit at all, so `subscribe` in a loop was an unmetered way to make
the process parse and validate as fast as a client could write. A fixed window
per socket, `RATE_LIMIT_SOCKET_MESSAGES_PER_MINUTE`, default 100 — a terminal
sends five subscribes on connect and one more when the chart changes instrument.

The refusal is announced once per window rather than on every message: answering
a client in a loop as fast as it asks is the traffic the limit exists to stop.

### Proved over HTTP

`pnpm pentest` includes three probes that attempt the whole administrative
surface with an ordinary trader's token — reading every user, changing another
user's state, and crediting an account — and assert a 403 _and_ that nothing
moved.
