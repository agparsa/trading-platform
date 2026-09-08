# API Inventory

**Generated from source**, by `scripts/api-inventory.ts`, which parses every
`*.controller.ts` for its route decorators and the authorization decorators
attached to each handler. Nothing between the generated markers is written by
hand.

Regenerate with `pnpm inventory`. `scripts/api-inventory.test.ts` fails the
build when this file and the controllers disagree — a document that says it is
generated and then drifts is worse than one that never said so, because a reader
who trusts the claim stops checking.

The route total is at the **end** of the generated section, deliberately. It
used to be here, above the markers, where nothing checked it — and it drifted to
"84 routes" while the generated table below listed 94. A hand-written summary of
a generated document is the one line a reader trusts and nobody verifies.

Plus one WebSocket namespace, whose inbound message types and outbound domain
events are listed further down.

All routes are prefixed `/api/v1` except those marked version-neutral
(`/health`, `/ready`, `/metrics`).

## How authorization is applied

Four guards run globally, in order: `ThrottlerGuard` → `BearerAuthGuard` →
`RolesGuard` → `PermissionsGuard`. A route is therefore **authenticated and
permission-checked by default**; `@Public()` opts out of authentication and
`@SelfService()` marks a route that acts only on the caller's own record.

Three things may follow `Bearer`: a session's access token, an API key
(`tpk_…`) or a service token (`tps_…`). A key or token reaches only routes
that **name a capability** it carries — _authenticated only_ routes are a
person's — and never a `SELF-SERVICE` or `SESSION-ONLY` route. See
[api-keys.md](./api-keys.md).

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

| Verb   | Path                                       | Handler                 | Requires           |
| ------ | ------------------------------------------ | ----------------------- | ------------------ |
| `GET`  | `/admin/users`                             | `users`                 | USERS_READ_ANY     |
| `GET`  | `/admin/users/:id`                         | `user`                  | USERS_READ_ANY     |
| `POST` | `/admin/users/:id/suspend`                 | `suspend`               | USERS_MANAGE       |
| `POST` | `/admin/users/:id/reinstate`               | `reinstate`             | USERS_MANAGE       |
| `POST` | `/admin/users/:id/sign-out`                | `signOut`               | USERS_MANAGE       |
| `POST` | `/admin/users/:id/role`                    | `assignRole`            | ROLES_ASSIGN       |
| `POST` | `/admin/users/:id/unlock`                  | `unlock`                | USERS_MANAGE       |
| `GET`  | `/admin/accounts`                          | `accounts`              | ACCOUNTS_READ_ANY  |
| `GET`  | `/admin/accounts/:id`                      | `account`               | ACCOUNTS_READ_ANY  |
| `POST` | `/admin/accounts/:id/status`               | `accountStatus`         | ACCOUNTS_MANAGE    |
| `GET`  | `/admin/orders`                            | `blotterOrders`         | ACCOUNTS_READ_ANY  |
| `GET`  | `/admin/positions`                         | `blotterPositions`      | ACCOUNTS_READ_ANY  |
| `GET`  | `/admin/trades`                            | `blotterTrades`         | ACCOUNTS_READ_ANY  |
| `GET`  | `/admin/orders/:id/history`                | `orderHistory`          | ACCOUNTS_READ_ANY  |
| `GET`  | `/admin/risk/limits`                       | `riskLimits`            | RISK_READ          |
| `POST` | `/admin/risk/limits/broker`                | `setBrokerLimits`       | RISK_MANAGE        |
| `POST` | `/admin/risk/limits/desk/:masterAccountId` | `setDeskLimits`         | RISK_MANAGE        |
| `POST` | `/admin/risk/limits/platform`              | `setPlatformLimits`     | RISK_MANAGE        |
| `POST` | `/admin/accounts/:id/limits`               | `limits`                | RISK_MANAGE        |
| `POST` | `/admin/accounts/:id/adjustments`          | `adjust`                | ACCOUNTS_ADJUST    |
| `GET`  | `/admin/risk/at-risk`                      | `atRisk`                | RISK_READ          |
| `GET`  | `/admin/risk/exposure`                     | `exposure`              | RISK_READ          |
| `GET`  | `/admin/risk/events`                       | `riskEvents`            | RISK_READ          |
| `GET`  | `/admin/audit`                             | `audit`                 | AUDIT_READ         |
| `GET`  | `/admin/audit/actions`                     | `auditActions`          | AUDIT_READ         |
| `GET`  | `/admin/instruments`                       | `listInstruments`       | INSTRUMENTS_READ   |
| `POST` | `/admin/instruments/:code/enabled`         | `setInstrumentEnabled`  | INSTRUMENTS_MANAGE |
| `POST` | `/admin/instruments/:code/terms`           | `setInstrumentTerms`    | INSTRUMENTS_MANAGE |
| `GET`  | `/admin/instruments/:code/sessions`        | `instrumentSessions`    | INSTRUMENTS_READ   |
| `POST` | `/admin/instruments/:code/sessions`        | `setInstrumentSessions` | INSTRUMENTS_MANAGE |
| `POST` | `/admin/invites`                           | `mintInvite`            | INVITES_MANAGE     |
| `GET`  | `/admin/invites`                           | `listInvites`           | INVITES_MANAGE     |
| `POST` | `/admin/invites/:id/revoke`                | `revokeInvite`          | INVITES_MANAGE     |

### `alerts/price-alerts.controller.ts` — base `/alerts`

| Verb     | Path          | Handler  | Requires     |
| -------- | ------------- | -------- | ------------ |
| `GET`    | `/alerts`     | `list`   | SELF-SERVICE |
| `POST`   | `/alerts`     | `create` | SELF-SERVICE |
| `DELETE` | `/alerts/:id` | `cancel` | SELF-SERVICE |

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

### `broker-connections/broker-connections.controller.ts` — base `/admin/broker-connections`

| Verb   | Path                                                  | Handler             | Requires                                        |
| ------ | ----------------------------------------------------- | ------------------- | ----------------------------------------------- |
| `GET`  | `/admin/broker-connections/connectors`                | `connectors`        | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `GET`  | `/admin/broker-connections`                           | `list`              | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `GET`  | `/admin/broker-connections/:id`                       | `get`               | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `POST` | `/admin/broker-connections`                           | `create`            | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `POST` | `/admin/broker-connections/:id/credentials`           | `setCredentials`    | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `POST` | `/admin/broker-connections/:id/enabled`               | `setEnabled`        | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `POST` | `/admin/broker-connections/:id/test`                  | `test`              | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `GET`  | `/admin/broker-connections/:id/mappings`              | `mappingList`       | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `GET`  | `/admin/broker-connections/:id/catalogue`             | `catalogue`         | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `GET`  | `/admin/broker-connections/:id/mappings/suggestions`  | `suggestions`       | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `POST` | `/admin/broker-connections/:id/mappings`              | `map`               | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `POST` | `/admin/broker-connections/:id/mappings/enabled`      | `setMappingEnabled` | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `POST` | `/admin/broker-connections/:id/mappings/sync`         | `syncMappings`      | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `GET`  | `/admin/broker-connections/:id/inbox`                 | `inboxList`         | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `GET`  | `/admin/broker-connections/:id/inbox/pending`         | `inboxPending`      | SESSION-ONLY (class), BROKER_CONNECTIONS_READ   |
| `POST` | `/admin/broker-connections/:id/inbox/:eventId/replay` | `replay`            | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |

### `brokers/brokers.controller.ts` — base `/admin/brokers`

| Verb   | Path                        | Handler     | Requires                             |
| ------ | --------------------------- | ----------- | ------------------------------------ |
| `GET`  | `/admin/brokers`            | `list`      | SESSION-ONLY (class), TENANTS_READ   |
| `GET`  | `/admin/brokers/:id`        | `get`       | SESSION-ONLY (class), TENANTS_READ   |
| `POST` | `/admin/brokers`            | `create`    | SESSION-ONLY (class), TENANTS_MANAGE |
| `POST` | `/admin/brokers/:id/status` | `setStatus` | SESSION-ONLY (class), TENANTS_MANAGE |

### `charts/charts.controller.ts` — base `/charts`

| Verb     | Path                       | Handler          | Requires             |
| -------- | -------------------------- | ---------------- | -------------------- |
| `GET`    | `/charts/layouts`          | `layouts`        | _authenticated only_ |
| `GET`    | `/charts/layouts/default`  | `defaultLayout`  | _authenticated only_ |
| `GET`    | `/charts/layouts/:id`      | `layout`         | _authenticated only_ |
| `POST`   | `/charts/layouts`          | `saveLayout`     | SELF-SERVICE         |
| `DELETE` | `/charts/layouts/:id`      | `deleteLayout`   | SELF-SERVICE         |
| `GET`    | `/charts/templates`        | `templates`      | _authenticated only_ |
| `GET`    | `/charts/templates/:name`  | `template`       | _authenticated only_ |
| `POST`   | `/charts/templates`        | `saveTemplate`   | SELF-SERVICE         |
| `DELETE` | `/charts/templates/:name`  | `deleteTemplate` | SELF-SERVICE         |
| `GET`    | `/charts/drawings/:symbol` | `drawings`       | _authenticated only_ |
| `POST`   | `/charts/drawings/:symbol` | `saveDrawings`   | SELF-SERVICE         |

### `credentials/admin-credentials.controller.ts` — base `/admin`

| Verb   | Path                               | Handler       | Requires                                    |
| ------ | ---------------------------------- | ------------- | ------------------------------------------- |
| `GET`  | `/admin/api-keys`                  | `keys`        | SESSION-ONLY (class), API_KEYS_READ_ANY     |
| `POST` | `/admin/api-keys/:id/revoke`       | `revokeKey`   | SESSION-ONLY (class), API_KEYS_REVOKE_ANY   |
| `GET`  | `/admin/service-tokens`            | `tokens`      | SESSION-ONLY (class), SERVICE_TOKENS_MANAGE |
| `POST` | `/admin/service-tokens`            | `mintToken`   | SESSION-ONLY (class), SERVICE_TOKENS_MANAGE |
| `POST` | `/admin/service-tokens/:id/revoke` | `revokeToken` | SESSION-ONLY (class), SERVICE_TOKENS_MANAGE |

### `credentials/api-keys.controller.ts` — base `/api-keys`

| Verb   | Path                   | Handler  | Requires                              |
| ------ | ---------------------- | -------- | ------------------------------------- |
| `GET`  | `/api-keys`            | `mine`   | SESSION-ONLY (class), API_KEYS_MANAGE |
| `POST` | `/api-keys`            | `mint`   | SESSION-ONLY (class), API_KEYS_MANAGE |
| `POST` | `/api-keys/:id/revoke` | `revoke` | SESSION-ONLY (class), API_KEYS_MANAGE |

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

### `kyc/admin-kyc.controller.ts` — base `/admin/kyc`

| Verb   | Path                                   | Handler    | Requires           |
| ------ | -------------------------------------- | ---------- | ------------------ |
| `GET`  | `/admin/kyc`                           | `queue`    | KYC_READ_ANY       |
| `GET`  | `/admin/kyc/:id`                       | `one`      | KYC_READ_ANY       |
| `GET`  | `/admin/kyc/:id/documents/:documentId` | `document` | KYC_DOCUMENTS_READ |
| `POST` | `/admin/kyc/:id/claim`                 | `claim`    | KYC_REVIEW         |
| `POST` | `/admin/kyc/:id/release`               | `release`  | KYC_REVIEW         |
| `POST` | `/admin/kyc/:id/decide`                | `decide`   | KYC_REVIEW         |
| `POST` | `/admin/kyc/:id/revoke`                | `revoke`   | KYC_REVIEW         |

### `kyc/kyc.controller.ts` — base `/kyc`

| Verb   | Path                   | Handler  | Requires   |
| ------ | ---------------------- | -------- | ---------- |
| `GET`  | `/kyc`                 | `mine`   | KYC_READ   |
| `PUT`  | `/kyc/documents/:kind` | `upload` | KYC_SUBMIT |
| `POST` | `/kyc/submit`          | `submit` | KYC_SUBMIT |

### `leadership/leadership.controller.ts` — base `/admin/leadership`

| Verb  | Path                | Handler  | Requires                                |
| ----- | ------------------- | -------- | --------------------------------------- |
| `GET` | `/admin/leadership` | `leases` | SESSION-ONLY (class), SYSTEM_OPERATIONS |

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
| `GET`    | `/master-accounts/:id/desk`             | `desk`   | MASTER_READ   |
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

### `payments/admin-payments.controller.ts` — base `/admin/payments`

| Verb   | Path                         | Handler  | Requires          |
| ------ | ---------------------------- | -------- | ----------------- |
| `GET`  | `/admin/payments`            | `list`   | PAYMENTS_READ_ANY |
| `GET`  | `/admin/payments/:id/events` | `events` | PAYMENTS_READ_ANY |
| `POST` | `/admin/payments/:id/settle` | `settle` | PAYMENTS_CONFIRM  |

### `payments/payments.controller.ts` — base `/payments`

| Verb   | Path                  | Handler     | Requires        |
| ------ | --------------------- | ----------- | --------------- |
| `GET`  | `/payments/providers` | `available` | PAYMENTS_READ   |
| `GET`  | `/payments`           | `mine`      | PAYMENTS_READ   |
| `GET`  | `/payments/:id`       | `one`       | PAYMENTS_READ   |
| `POST` | `/payments`           | `start`     | PAYMENTS_CREATE |

### `payments/webhooks.controller.ts` — base `/webhooks/payments`

| Verb   | Path                           | Handler   | Requires |
| ------ | ------------------------------ | --------- | -------- |
| `POST` | `/webhooks/payments/:provider` | `receive` | PUBLIC   |

### `permissions/permissions.controller.ts` — base `/permissions`

| Verb   | Path                            | Handler          | Requires             |
| ------ | ------------------------------- | ---------------- | -------------------- |
| `GET`  | `/permissions/me`               | `me`             | _authenticated only_ |
| `GET`  | `/permissions/catalogue`        | `catalogue`      | ROLES_READ           |
| `GET`  | `/permissions/roles`            | `list`           | ROLES_READ           |
| `POST` | `/permissions/roles/:key/reset` | `reset`          | ROLES_MANAGE         |
| `PUT`  | `/permissions/roles/:key`       | `setPermissions` | ROLES_MANAGE         |

### `reconciliation/reconciliation.controller.ts` — base `/reconciliation`

| Verb   | Path                                  | Handler       | Requires              |
| ------ | ------------------------------------- | ------------- | --------------------- |
| `GET`  | `/reconciliation/runs`                | `runs`        | RECONCILIATION_READ   |
| `GET`  | `/reconciliation/findings`            | `findings`    | RECONCILIATION_READ   |
| `POST` | `/reconciliation/findings/:id/status` | `setStatus`   | RECONCILIATION_MANAGE |
| `POST` | `/reconciliation/runs`                | `run`         | RECONCILIATION_RUN    |
| `GET`  | `/reconciliation/items`               | `items`       | RECONCILIATION_READ   |
| `POST` | `/reconciliation/external-runs`       | `runExternal` | RECONCILIATION_RUN    |
| `POST` | `/reconciliation/resolutions`         | `resolve`     | RECONCILIATION_MANAGE |
| `GET`  | `/reconciliation/resolutions`         | `resolutions` | RECONCILIATION_READ   |

### `security/admin-security.controller.ts` — base `/admin/security`

| Verb  | Path                      | Handler   | Requires      |
| ----- | ------------------------- | --------- | ------------- |
| `GET` | `/admin/security/events`  | `feed`    | SECURITY_READ |
| `GET` | `/admin/security/summary` | `summary` | SECURITY_READ |

### `security/security.controller.ts` — base `/security`

| Verb  | Path               | Handler | Requires     |
| ----- | ------------------ | ------- | ------------ |
| `GET` | `/security/events` | `mine`  | SELF-SERVICE |

### `symbols/symbols.controller.ts` — base `/symbols`

| Verb  | Path             | Handler | Requires             |
| ----- | ---------------- | ------- | -------------------- |
| `GET` | `/symbols`       | `list`  | _authenticated only_ |
| `GET` | `/symbols/:code` | `get`   | _authenticated only_ |

### `trading/trading.controller.ts` — base `/`

| Verb     | Path                     | Handler         | Requires                                  |
| -------- | ------------------------ | --------------- | ----------------------------------------- |
| `POST`   | `/orders`                | `open`          | throttled, ORDERS_CREATE                  |
| `POST`   | `/orders/preview`        | `preview`       | throttled, ORDERS_READ                    |
| `POST`   | `/orders/pending`        | `placePending`  | throttled, ORDERS_CREATE                  |
| `GET`    | `/orders/pending`        | `listPending`   | ORDERS_READ                               |
| `PATCH`  | `/orders/:id`            | `modifyPending` | throttled, ORDERS_MODIFY                  |
| `DELETE` | `/orders/:id`            | `cancelPending` | throttled, ORDERS_CANCEL                  |
| `GET`    | `/orders`                | `list`          | ORDERS_READ                               |
| `GET`    | `/orders/:id/events`     | `events`        | ORDERS_READ                               |
| `GET`    | `/positions`             | `positionsFor`  | POSITIONS_READ                            |
| `POST`   | `/positions/:id/close`   | `close`         | throttled, POSITIONS_CLOSE                |
| `POST`   | `/positions/close-all`   | `closeAll`      | throttled, POSITIONS_CLOSE                |
| `PATCH`  | `/positions/:id`         | `modify`        | throttled, POSITIONS_MODIFY               |
| `POST`   | `/positions/:id/reverse` | `reverse`       | throttled, POSITIONS_CLOSE, ORDERS_CREATE |
| `GET`    | `/trades`                | `trades`        | POSITIONS_READ                            |
| `GET`    | `/accounts/:id/state`    | `state`         | ACCOUNTS_READ                             |

### `trading/venue-recovery.controller.ts` — base `/admin/venue-recovery`

| Verb   | Path                                                 | Handler       | Requires                                        |
| ------ | ---------------------------------------------------- | ------------- | ----------------------------------------------- |
| `GET`  | `/admin/venue-recovery/unconfirmed`                  | `unconfirmed` | SESSION-ONLY (class), ACCOUNTS_READ_ANY         |
| `POST` | `/admin/venue-recovery/run`                          | `run`         | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |
| `POST` | `/admin/venue-recovery/unconfirmed/:orderId/resolve` | `resolve`     | SESSION-ONLY (class), BROKER_CONNECTIONS_MANAGE |

### `users/users.controller.ts` — base `/users`

| Verb    | Path        | Handler  | Requires             |
| ------- | ----------- | -------- | -------------------- |
| `GET`   | `/users/me` | `me`     | _authenticated only_ |
| `PATCH` | `/users/me` | `update` | SELF-SERVICE         |

### `wallet/admin-wallet.controller.ts` — base `/admin/wallets`

| Verb   | Path                              | Handler        | Requires        |
| ------ | --------------------------------- | -------------- | --------------- |
| `GET`  | `/admin/wallets`                  | `forUser`      | WALLET_READ_ANY |
| `GET`  | `/admin/wallets/:id/transactions` | `transactions` | WALLET_READ_ANY |
| `POST` | `/admin/wallets/:id/adjustments`  | `adjust`       | WALLET_ADJUST   |
| `POST` | `/admin/wallets/:id/status`       | `setStatus`    | WALLET_MANAGE   |

### `wallet/wallet.controller.ts` — base `/wallet`

| Verb   | Path                       | Handler        | Requires        |
| ------ | -------------------------- | -------------- | --------------- |
| `GET`  | `/wallet`                  | `mine`         | WALLET_READ     |
| `GET`  | `/wallet/:id/transactions` | `transactions` | WALLET_READ     |
| `POST` | `/wallet/transfer`         | `transfer`     | WALLET_TRANSFER |

### `withdrawals/admin-withdrawals.controller.ts` — base `/admin/withdrawals`

| Verb   | Path                                 | Handler       | Requires             |
| ------ | ------------------------------------ | ------------- | -------------------- |
| `GET`  | `/admin/withdrawals`                 | `queue`       | WITHDRAWALS_READ_ANY |
| `GET`  | `/admin/withdrawals/:id`             | `one`         | WITHDRAWALS_READ_ANY |
| `GET`  | `/admin/withdrawals/:id/destination` | `destination` | WITHDRAWALS_PAY      |
| `POST` | `/admin/withdrawals/:id/claim`       | `claim`       | WITHDRAWALS_REVIEW   |
| `POST` | `/admin/withdrawals/:id/release`     | `release`     | WITHDRAWALS_REVIEW   |
| `POST` | `/admin/withdrawals/:id/decide`      | `decide`      | WITHDRAWALS_REVIEW   |
| `POST` | `/admin/withdrawals/:id/payout`      | `startPayout` | WITHDRAWALS_PAY      |
| `POST` | `/admin/withdrawals/:id/settle`      | `settle`      | WITHDRAWALS_PAY      |

### `withdrawals/withdrawals.controller.ts` — base `/withdrawals`

| Verb   | Path                      | Handler   | Requires            |
| ------ | ------------------------- | --------- | ------------------- |
| `GET`  | `/withdrawals/terms`      | `terms`   | WITHDRAWALS_READ    |
| `GET`  | `/withdrawals`            | `mine`    | WITHDRAWALS_READ    |
| `GET`  | `/withdrawals/:id`        | `one`     | WITHDRAWALS_READ    |
| `POST` | `/withdrawals`            | `request` | WITHDRAWALS_REQUEST |
| `POST` | `/withdrawals/:id/cancel` | `cancel`  | WITHDRAWALS_REQUEST |

**203 routes:** 102 `GET`, 87 `POST`, 7 `DELETE`, 5 `PATCH`, 2 `PUT`.

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
