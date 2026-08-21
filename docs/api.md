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

## Planned surface

Delivered in Phase 1: `/health`, `/ready`, `/metrics` (all version-neutral, so an
orchestrator's probe does not break when the API moves to v2).

Planned, phase by phase:

```
Phase 2   POST   /auth/register  /auth/login  /auth/refresh  /auth/logout
          GET    /users/me
          GET    /accounts        /accounts/:id

Phase 3   GET    /symbols         /symbols/:code
          GET    /market/quotes   /market/candles

Phase 4   POST   /orders                       (Idempotency-Key)
          GET    /orders          /orders/:id
          PATCH  /orders/:id                   (Idempotency-Key)
          DELETE /orders/:id                   (Idempotency-Key)
          GET    /positions       /positions/:id
          POST   /positions/:id/close          (Idempotency-Key)
          POST   /positions/:id/reverse        (Idempotency-Key)
          PATCH  /positions/:id                (Idempotency-Key)
          GET    /trades          /executions  /history
```

## Validation

Request DTOs are Zod schemas, validated by a global `ZodValidationPipe`. The same
library validates the environment contract and the shared wire types, so a rule
about a price format is written once instead of once per layer.

## Rate limits

Trading actions are protected more tightly than reads:

| Bucket                        | Default      |
| ----------------------------- | ------------ |
| Login                         | 5 / minute   |
| Order create / modify / close | 120 / minute |
| Everything else               | 600 / minute |
