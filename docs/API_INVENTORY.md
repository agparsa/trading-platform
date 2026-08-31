# API Inventory

**Generated from source**, by `scripts/api-inventory.ts`, which parses every
`*.controller.ts` for its route decorators and the authorization decorators
attached to each handler. Nothing between the generated markers is written by
hand.

Regenerate with `pnpm inventory`. `scripts/api-inventory.test.ts` fails the
build when this file and the controllers disagree — a document that says it is
generated and then drifts is worse than one that never said so, because a reader
who trusts the claim stops checking.

**Totals:** 15 controllers, 84 HTTP routes — 43 `GET`, 35 `POST`, 3 `PATCH`,
3 `DELETE`. Plus one WebSocket namespace with 3 inbound message types and 24
outbound domain events.

All routes are prefixed `/api/v1` except those marked version-neutral
(`/health`, `/ready`, `/metrics`).

## How authorization is applied

Four guards run globally, in order: `ThrottlerGuard` → `JwtAuthGuard` →
`RolesGuard` → `PermissionsGuard`. A route is therefore **authenticated and
permission-checked by default**; `@Public()` opts out of authentication and
`@SelfService()` marks a route that acts only on the caller's own record.

The column below records what each handler actually demands. Where it says
_authenticated only_, the route is reachable by any signed-in user and the
handler is responsible for scoping the result to that user — which for
`/accounts/*`, `/notifications/*` and `/users/me` it does, by passing
`user.id` into the service rather than trusting a parameter.

---

<!-- BEGIN GENERATED ROUTES -->

### `accounts/accounts.controller.ts` — base `/accounts`

| Verb  | Path                     | Handler    | Requires      |
| ----- | ------------------------ | ---------- | ------------- |
| `GET` | `/accounts`              | `list`     | ACCOUNTS_READ |
| `GET` | `/accounts/:id`          | `get`      | ACCOUNTS_READ |
| `GET` | `/accounts/:id/settings` | `settings` | ACCOUNTS_READ |
| `GET` | `/accounts/:id/ledger`   | `ledger`   | ACCOUNTS_READ |

### `admin/admin.controller.ts` — base `/admin`

| Verb   | Path                               | Handler                | Requires           |
| ------ | ---------------------------------- | ---------------------- | ------------------ |
| `GET`  | `/admin/users`                     | `users`                | USERS_READ_ANY     |
| `GET`  | `/admin/users/:id`                 | `user`                 | USERS_READ_ANY     |
| `POST` | `/admin/users/:id/suspend`         | `suspend`              | USERS_MANAGE       |
| `POST` | `/admin/users/:id/reinstate`       | `reinstate`            | USERS_MANAGE       |
| `POST` | `/admin/users/:id/sign-out`        | `signOut`              | USERS_MANAGE       |
| `POST` | `/admin/users/:id/unlock`          | `unlock`               | USERS_MANAGE       |
| `GET`  | `/admin/accounts`                  | `accounts`             | ACCOUNTS_READ_ANY  |
| `POST` | `/admin/accounts/:id/status`       | `accountStatus`        | ACCOUNTS_MANAGE    |
| `POST` | `/admin/accounts/:id/limits`       | `limits`               | RISK_MANAGE        |
| `POST` | `/admin/accounts/:id/adjustments`  | `adjust`               | ACCOUNTS_ADJUST    |
| `GET`  | `/admin/risk/at-risk`              | `atRisk`               | RISK_READ          |
| `GET`  | `/admin/risk/exposure`             | `exposure`             | RISK_READ          |
| `GET`  | `/admin/risk/events`               | `riskEvents`           | RISK_READ          |
| `GET`  | `/admin/audit`                     | `audit`                | AUDIT_READ         |
| `GET`  | `/admin/audit/actions`             | `auditActions`         | AUDIT_READ         |
| `GET`  | `/admin/instruments`               | `listInstruments`      | INSTRUMENTS_READ   |
| `POST` | `/admin/instruments/:code/enabled` | `setInstrumentEnabled` | INSTRUMENTS_MANAGE |
| `POST` | `/admin/instruments/:code/terms`   | `setInstrumentTerms`   | INSTRUMENTS_MANAGE |
| `POST` | `/admin/invites`                   | `mintInvite`           | INVITES_MANAGE     |
| `GET`  | `/admin/invites`                   | `listInvites`          | INVITES_MANAGE     |
| `POST` | `/admin/invites/:id/revoke`        | `revokeInvite`         | INVITES_MANAGE     |

### `auth/auth.controller.ts` — base `/auth`

| Verb     | Path                           | Handler                   | Requires                |
| -------- | ------------------------------ | ------------------------- | ----------------------- |
| `POST`   | `/auth/register`               | `register`                | PUBLIC, throttled       |
| `POST`   | `/auth/login`                  | `login`                   | PUBLIC, throttled       |
| `POST`   | `/auth/login/2fa`              | `loginTwoFactor`          | PUBLIC, throttled       |
| `GET`    | `/auth/2fa`                    | `twoFactorStatus`         | SELF-SERVICE            |
| `POST`   | `/auth/2fa/enrol`              | `beginTwoFactorEnrolment` | SELF-SERVICE, throttled |
| `POST`   | `/auth/2fa/activate`           | `activateTwoFactor`       | SELF-SERVICE, throttled |
| `POST`   | `/auth/2fa/disable`            | `disableTwoFactor`        | SELF-SERVICE, throttled |
| `GET`    | `/auth/sessions`               | `listSessions`            | SELF-SERVICE            |
| `DELETE` | `/auth/sessions/:id`           | `revokeSession`           | SELF-SERVICE            |
| `POST`   | `/auth/refresh`                | `refresh`                 | PUBLIC, throttled       |
| `POST`   | `/auth/logout`                 | `logout`                  | PUBLIC                  |
| `POST`   | `/auth/verify-email`           | `verifyEmail`             | PUBLIC                  |
| `POST`   | `/auth/password-reset`         | `requestPasswordReset`    | PUBLIC, throttled       |
| `POST`   | `/auth/password-reset/confirm` | `resetPassword`           | PUBLIC, throttled       |
| `POST`   | `/auth/password`               | `changePassword`          | SELF-SERVICE            |
| `GET`    | `/auth/me`                     | `me`                      | _authenticated only_    |

### `devices/devices.controller.ts` — base `/devices`

| Verb     | Path           | Handler      | Requires             |
| -------- | -------------- | ------------ | -------------------- |
| `GET`    | `/devices`     | `list`       | _authenticated only_ |
| `POST`   | `/devices`     | `register`   | SELF-SERVICE         |
| `DELETE` | `/devices/:id` | `deactivate` | SELF-SERVICE         |

### `health/health.controller.ts` — base `/`

| Verb  | Path             | Handler  | Requires       |
| ----- | ---------------- | -------- | -------------- |
| `GET` | `/health`        | `live`   | PUBLIC (class) |
| `GET` | `/ready`         | `ready`  | PUBLIC (class) |
| `GET` | `/health/market` | `market` | PUBLIC (class) |

### `integrity/integrity.controller.ts` — base `/integrity`

| Verb   | Path                            | Handler     | Requires         |
| ------ | ------------------------------- | ----------- | ---------------- |
| `GET`  | `/integrity/signals`            | `list`      | INTEGRITY_READ   |
| `GET`  | `/integrity/signals/:id`        | `detail`    | INTEGRITY_READ   |
| `POST` | `/integrity/signals/:id/status` | `setStatus` | INTEGRITY_MANAGE |
| `POST` | `/integrity/scan/:accountId`    | `scan`      | INTEGRITY_MANAGE |

### `market/market.controller.ts` — base `/market`

| Verb  | Path              | Handler      | Requires             |
| ----- | ----------------- | ------------ | -------------------- |
| `GET` | `/market/quotes`  | `quotes_`    | _authenticated only_ |
| `GET` | `/market/stats`   | `stats`      | _authenticated only_ |
| `GET` | `/market/candles` | `candlesFor` | _authenticated only_ |

### `master/master-accounts.controller.ts` — base `/master-accounts`

| Verb     | Path                                    | Handler  | Requires      |
| -------- | --------------------------------------- | -------- | ------------- |
| `GET`    | `/master-accounts`                      | `list`   | MASTER_READ   |
| `GET`    | `/master-accounts/:id/links`            | `links`  | MASTER_READ   |
| `POST`   | `/master-accounts`                      | `create` | MASTER_MANAGE |
| `POST`   | `/master-accounts/:id/links`            | `grant`  | MASTER_MANAGE |
| `DELETE` | `/master-accounts/:id/links/:accountId` | `revoke` | MASTER_MANAGE |

### `metrics/metrics.controller.ts` — base `/metrics`

| Verb  | Path       | Handler  | Requires       |
| ----- | ---------- | -------- | -------------- |
| `GET` | `/metrics` | `scrape` | PUBLIC (class) |

### `notifications/notifications.controller.ts` — base `/notifications`

| Verb    | Path                                   | Handler          | Requires             |
| ------- | -------------------------------------- | ---------------- | -------------------- |
| `GET`   | `/notifications`                       | `list`           | _authenticated only_ |
| `GET`   | `/notifications/unread-count`          | `unread`         | _authenticated only_ |
| `POST`  | `/notifications/:id/read`              | `read`           | SELF-SERVICE         |
| `POST`  | `/notifications/read-all`              | `readAll`        | SELF-SERVICE         |
| `GET`   | `/notifications/preferences`           | `preferencesFor` | _authenticated only_ |
| `PATCH` | `/notifications/preferences`           | `updateSettings` | SELF-SERVICE         |
| `PATCH` | `/notifications/preferences/:category` | `updateCategory` | SELF-SERVICE         |

### `operations/operations.controller.ts` — base `/operations`

| Verb   | Path                        | Handler        | Requires           |
| ------ | --------------------------- | -------------- | ------------------ |
| `GET`  | `/operations/summary`       | `summary`      | SYSTEM_OPERATIONS  |
| `GET`  | `/operations/trading-state` | `tradingState` | SYSTEM_OPERATIONS  |
| `POST` | `/operations/halt`          | `halt`         | SYSTEM_KILL_SWITCH |
| `POST` | `/operations/resume`        | `resume`       | SYSTEM_KILL_SWITCH |

### `permissions/permissions.controller.ts` — base `/permissions`

| Verb  | Path              | Handler | Requires             |
| ----- | ----------------- | ------- | -------------------- |
| `GET` | `/permissions/me` | `me`    | _authenticated only_ |

### `reconciliation/reconciliation.controller.ts` — base `/reconciliation`

| Verb   | Path                                  | Handler     | Requires              |
| ------ | ------------------------------------- | ----------- | --------------------- |
| `GET`  | `/reconciliation/runs`                | `runs`      | RECONCILIATION_READ   |
| `GET`  | `/reconciliation/findings`            | `findings`  | RECONCILIATION_READ   |
| `POST` | `/reconciliation/findings/:id/status` | `setStatus` | RECONCILIATION_MANAGE |
| `POST` | `/reconciliation/runs`                | `run`       | RECONCILIATION_RUN    |

### `symbols/symbols.controller.ts` — base `/symbols`

| Verb  | Path             | Handler | Requires             |
| ----- | ---------------- | ------- | -------------------- |
| `GET` | `/symbols`       | `list`  | _authenticated only_ |
| `GET` | `/symbols/:code` | `get`   | _authenticated only_ |

### `trading/trading.controller.ts` — base `/`

| Verb     | Path                     | Handler         | Requires                                  |
| -------- | ------------------------ | --------------- | ----------------------------------------- |
| `POST`   | `/orders`                | `open`          | throttled, ORDERS_CREATE                  |
| `POST`   | `/orders/pending`        | `placePending`  | throttled, ORDERS_CREATE                  |
| `GET`    | `/orders/pending`        | `listPending`   | ORDERS_READ                               |
| `PATCH`  | `/orders/:id`            | `modifyPending` | throttled, ORDERS_MODIFY                  |
| `DELETE` | `/orders/:id`            | `cancelPending` | throttled, ORDERS_CANCEL                  |
| `GET`    | `/orders`                | `list`          | ORDERS_READ                               |
| `GET`    | `/orders/:id/events`     | `events`        | ORDERS_READ                               |
| `GET`    | `/positions`             | `positionsFor`  | POSITIONS_READ                            |
| `POST`   | `/positions/:id/close`   | `close`         | throttled, POSITIONS_CLOSE                |
| `PATCH`  | `/positions/:id`         | `modify`        | throttled, POSITIONS_MODIFY               |
| `POST`   | `/positions/:id/reverse` | `reverse`       | throttled, POSITIONS_CLOSE, ORDERS_CREATE |
| `GET`    | `/trades`                | `trades`        | POSITIONS_READ                            |
| `GET`    | `/accounts/:id/state`    | `state`         | ACCOUNTS_READ                             |

### `users/users.controller.ts` — base `/users`

| Verb    | Path        | Handler  | Requires             |
| ------- | ----------- | -------- | -------------------- |
| `GET`   | `/users/me` | `me`     | _authenticated only_ |
| `PATCH` | `/users/me` | `update` | SELF-SERVICE         |

**93 routes:** 46 `GET`, 38 `POST`, 5 `PATCH`, 4 `DELETE`.

<!-- END GENERATED ROUTES -->

| `PATCH` | `/users/me` | `update` | `@SelfService()` |

---

## Reading the table

`_authenticated only_` means the route declares no permission: it is reachable
by any signed-in user, and the handler is responsible for scoping the result —
which for `/accounts/*`, `/notifications/*` and `/users/me` it does, by passing
`user.id` into the service rather than trusting a parameter.

`PUBLIC (class)` marks the two controllers that carry `@Public()` on the class:
health and metrics. `/metrics` is additionally restricted to private IP ranges
inside the handler, which is why a scrape from outside the network is refused
rather than served.

## Findings

**1. A write gated by a read permission.** _Fixed._

`POST /reconciliation/findings/:id/status` required `RECONCILIATION_READ`, and
`OPERATOR` holds read. It changes a finding's state and records who decided it,
so an operator could declare a money discrepancy resolved on a permission whose
name says read.

It now requires `RECONCILIATION_MANAGE`, held by `RISK_MANAGER` and `ADMIN`. An
operator can still see every finding and escalate it. The generated table above
reflects the fix.

**2. `/symbols` and `/market/*` are authenticated but not permission-checked.**
Reasonable — instrument definitions and quotes are not per-user data. Recorded
so it is a decision rather than an oversight. Under multi-tenancy this changes:
instrument availability becomes tenant-scoped and these routes will need
tenant derivation.

**3. No route accepts a tenant identifier, because there is no tenancy.**
When tenancy lands, the specification's rule applies without exception: the
tenant is derived from the authenticated context, never read from the request.

## WebSocket contract

Namespace: `/ws`. Authentication is by the same access token as HTTP.

| Direction | Message       | Payload                                                           |
| --------- | ------------- | ----------------------------------------------------------------- |
| in        | `subscribe`   | `{ accountId }` — joins the account room after an ownership check |
| in        | `unsubscribe` | `{ accountId }`                                                   |
| in        | `whoami`      | acknowledged with the authenticated identity                      |
| out       | envelope      | `{ eventId, seq, type, at, data }`                                |

Outbound event types, verified by grep against the source:

```
account.balance_adjusted   account.limits_changed     account.status_changed
account.updated            integrity.signal_raised    integrity.signal_reviewed
order.accepted             order.cancelled            order.created
order.filled               order.rejected             order.updated
position.closed            position.created           position.modified
position.opened            position.updated           risk.margin_call
risk.stop_out              risk.updated               system.trading_halted
system.trading_resumed
```

Plus market tick and candle frames on the market channel.

`eventId` is minted once per occurrence and carried through every delivery, so
a client that reconnects and replays can discard what it has already applied.
`seq` is per-connection and monotonic, so a client can detect a gap rather than
silently miss an event. This satisfies the master specification's duplicate-event
requirement on the transport; it does **not** yet exist for inbound webhooks,
because there are no inbound webhooks.

## What the API does not expose

Recorded because the specification asks for it and it does not exist. None of
these routes are present in any form:

```
/kyc/*            /wallet/*         /deposits/*       /withdrawals/*
/payments/*       /api-keys/*       /webhooks/*       /tenants/*
/security/*       /ai/*
```

`/devices/*` and `/notifications/preferences` were on that list until the
notification platform work began; they are in the table above now. The rest
still is not there, and this section is kept accurate rather than aspirational
— a specification item that is listed as done and is not is worse for a reader
than one honestly listed as missing.
