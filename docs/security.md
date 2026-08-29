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

## Rate limiting

Per-bucket limits, tightest on the endpoints that move money. Login is the
tightest of all. See [api.md](./api.md).

## Secrets

`.env` is git-ignored; `.env.example` carries placeholders only and is the file
committed. Deployments inject real values through the platform's secret manager.
Nothing in this repository holds a real credential.

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

## Authorisation

Roles are enforced as sets of `resource.verb` capabilities, checked in a global
guard on every declared route, with a build-time test that no mutating route can
be added without declaring what it requires. See
[permissions.md](./permissions.md) — including why `ADMIN` deliberately cannot
place an order.

## Not yet implemented

The admin audit surface and a penetration checklist are outstanding. They are
listed here as the contract later phases must meet, not as work already done.
