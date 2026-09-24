# REST API

Base path: `/api/v1`. OpenAPI document at `/docs` (and `/docs/openapi.json`),
served outside production.

## Envelopes

Every response uses one of two shapes. No endpoint returns a bare array or a
bare scalar — that would make adding metadata a breaking change later.

```jsonc
// success
{ "ok": true, "data": { }, "meta": { "requestId": "…", "serverTime": 1787307884014 } }

// failure
{ "ok": false, "error": { "code": "INSUFFICIENT_MARGIN", "message": "…", "requestId": "…",
                          "details": { "required": "4583.65", "available": "100.00" } } }
```

Clients switch on `error.code`, never on `message` or on the HTTP status alone.
Messages are human text and may be reworded or translated; codes are contract.

Stack traces, SQL and driver messages never cross this boundary. An unrecognised
exception is logged in full server-side and returned as a bare `INTERNAL_ERROR`
plus a `requestId` the user can quote.

## Headers

| Header                    | Direction | Meaning                                 |
| ------------------------- | --------- | --------------------------------------- |
| `Authorization: Bearer …` | in        | Access token                            |
| `Idempotency-Key`         | in        | **Required on every mutation.**         |
| `X-Request-Id`            | in / out  | Echoed if supplied, generated otherwise |

## Status mapping

The mapping is an explicit table (`domain-exception.filter.ts`), not a heuristic:

| Status    | Meaning here                               | Examples                                                             |
| --------- | ------------------------------------------ | -------------------------------------------------------------------- |
| 400       | Malformed request                          | `VALIDATION_FAILED`, `INVALID_VOLUME`                                |
| 401 / 403 | Auth                                       | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `FORBIDDEN`                      |
| 404       | Missing resource                           | `RESOURCE_NOT_FOUND`, `ORDER_NOT_FOUND`                              |
| 409       | Retryable race                             | `STALE_QUOTE`, `CONCURRENT_MODIFICATION`, `POSITION_ALREADY_CLOSING` |
| 422       | Well-formed but refused by a business rule | `INSUFFICIENT_MARGIN`, `MAX_EXPOSURE_EXCEEDED`                       |
| 429       | Rate limited                               | `RATE_LIMITED`                                                       |
| 503       | Dependency unavailable                     | `NO_QUOTE_AVAILABLE`, `SERVICE_UNAVAILABLE`                          |

The distinction that matters: 422 means _show the trader why_; 409 means _retry
against fresh state_. Guessing from the error name would get both wrong.

A unit test asserts that every code in the catalogue has an explicit status, so
adding a code without deciding its status fails the build.

## Surface

Infrastructure probes are version-neutral, so an orchestrator's check does not
break when the API moves to v2:

```
GET  /health   /ready   /metrics
```

Implemented under `/api/v1`:

```
Auth      POST   /auth/register              202, no body — see below
          POST   /auth/login  /auth/refresh  /auth/logout
          POST   /auth/verify-email
          POST   /auth/password-reset  /auth/password-reset/confirm
          POST   /auth/password              authenticated
          GET    /auth/me

Users     GET    /users/me       PATCH /users/me
          GET    /users/me/sessions

Accounts  GET    /accounts       /accounts/:id
          GET    /accounts/:id/settings
          GET    /accounts/:id/ledger        cursor-paginated
          GET    /accounts/:id/state         live equity, margin, floating P&L

Market    GET    /symbols        /symbols/:code
          GET    /market/quotes  /market/candles

Trading   POST   /orders                     ← Idempotency-Key
          GET    /orders         /orders/:id/events
          GET    /positions
          POST   /positions/:id/close        ← Idempotency-Key
          PATCH  /positions/:id              ← Idempotency-Key
          POST   /positions/:id/reverse      ← Idempotency-Key
          GET    /trades
```

Still to come: pending orders (`PATCH`/`DELETE /orders/:id`) in Phase 6, and the
WebSocket surface in Phase 7.

### Two endpoints that deliberately tell you nothing

`POST /auth/register` and `POST /auth/password-reset` both return `202` with a
generic message whether or not the address is registered. Both are
unauthenticated; a truthful response would turn either into an
account-enumeration oracle. Login returns one error for "no such user" and
"wrong password", and spends a full Argon2 verification against a dummy hash on
an unknown address so the timing matches too.

## Validation

Request DTOs are Zod schemas, validated by a global `ZodValidationPipe`. The same
library validates the environment contract and the shared wire types, so a rule
about a price format is written once instead of once per layer.

## Rate limits

Per caller address, per minute. Trading actions are protected more tightly than
reads, and anything that takes a password or a code more tightly than that:

| Bucket                  | Routes                                                                                                                                                                                                           | Default      | Setting                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------- |
| Sign-in and credentials | `POST /auth/register`, `POST /auth/login`, `POST /auth/login/2fa`, `POST /auth/2fa/enrol`, `POST /auth/2fa/activate`, `POST /auth/2fa/disable`, `POST /auth/password-reset`, `POST /auth/password-reset/confirm` | 5 / minute   | `RATE_LIMIT_LOGIN_PER_MINUTE`                                  |
| Token refresh           | `POST /auth/refresh`                                                                                                                                                                                             | 30 / minute  | six times `RATE_LIMIT_LOGIN_PER_MINUTE`                        |
| Orders and positions    | `POST /orders`, `POST /orders/pending`, `PATCH /orders/:id`, `DELETE /orders/:id`, `POST /positions/:id/close`, `POST /positions/close-all`, `PATCH /positions/:id`                                              | 120 / minute | `RATE_LIMIT_ORDERS_PER_MINUTE`                                 |
| Reversing a position    | `POST /positions/:id/reverse`                                                                                                                                                                                    | 60 / minute  | half `RATE_LIMIT_ORDERS_PER_MINUTE` — a reversal is two orders |
| Order preview           | `POST /orders/preview`                                                                                                                                                                                           | 600 / minute | `RATE_LIMIT_API_PER_MINUTE` — it places nothing                |
| Everything else         |                                                                                                                                                                                                                  | 600 / minute | `RATE_LIMIT_API_PER_MINUTE`                                    |

This table listed three buckets — login, "order create / modify / close", and
the rest — while registration, two-factor and password reset shared the sign-in
bucket, token refresh had one of its own, and a reversal counted double. It is
now checked against every `@Throttle` in the controllers by
`scripts/rate-limits.test.ts`, route by route and default by default.

### Ceilings that are not per address

Beneath the per-address buckets, so that many addresses cannot add up to more
than one account, one firm or one key should do:

| Ceiling                                          | Default        | Setting                                   |
| ------------------------------------------------ | -------------- | ----------------------------------------- |
| Orders from one trading account                  | 120 / minute   | `ORDER_RATE_LIMIT_PER_ACCOUNT_PER_MINUTE` |
| Orders from one firm, all its accounts together  | 6,000 / minute | `ORDER_RATE_LIMIT_PER_TENANT_PER_MINUTE`  |
| Requests made with one API key                   | 300 / minute   | `API_KEY_RATE_LIMIT_PER_MINUTE`           |
| Messages a WebSocket may send (subscribes, etc.) | 100 / minute   | `RATE_LIMIT_SOCKET_MESSAGES_PER_MINUTE`   |
