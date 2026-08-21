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
- 2FA: TOTP, secret stored per user.

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

## Not yet implemented

Phase 1 delivers the foundations above. Authentication, RBAC and the audit
writers land in Phase 2; rate limiting and the full audit surface complete in
Phase 11. They are listed here as the contract those phases must meet, not as
work already done.
