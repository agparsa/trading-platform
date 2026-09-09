# Webhooks

Where a firm asks to be told about its own events (§49), and how it is told.

## What is sent

Every event the transactional outbox carries — the `DomainEvent` catalogue:
`order.*`, `position.*`, `balance.changed`, `margin.call`, `liquidation`. An
endpoint subscribes to a list of them, or to everything, which includes events
added after it was registered.

The body is the outbox row, as JSON:

```json
{
  "id": "…",                  // the event's own id; one occurrence, one id
  "type": "order.filled",
  "occurredAt": "2026-09-09T18:02:11.412Z",
  "accountId": "…",
  "aggregate": { "type": "order", "id": "…" },
  "data": { … },              // the same payload the socket carried
  "replay": false             // true when a person asked for it again
}
```

Headers: `X-Signature`, `X-Event-Id`, `X-Event-Type`, `X-Delivery-Id`,
`Content-Type: application/json`.

The socket and the webhook carry the same `id` for the same occurrence. A
receiver that sees both may discard the second.

## Verifying a delivery

```
X-Signature: t=1725890000,v1=<hex hmac-sha256 over "<t>.<raw body>">
```

1. Read the **raw** request body. Do not re-serialise it — key order and
   spacing differ across stacks and the signature will fail on a genuine
   delivery.
2. Refuse the delivery if `t` is more than a few minutes from your clock. The
   timestamp is inside the MAC, so a captured delivery cannot be replayed
   later and its timestamp cannot be freshened without the secret.
3. Compute `HMAC-SHA256(secret, "<t>.<body>")` and compare it, in constant time,
   with every `v1` value present. During a secret rotation there are two; the
   delivery is genuine if either matches.
4. Answer 2xx. Anything else — including a redirect — is a failure and will be
   retried.

`@tp/webhooks-core` exports `verify()` for receivers written in TypeScript.

## The secret

Generated when the endpoint is registered, sealed under the platform's key
list with the endpoint id as context, and returned **once**: in the response
to registering, and in the response to rotating. It is nowhere else — not in
the list (which shows the last four characters), not in the delivery log, not
in the audit trail.

**Rotation keeps the old secret for a day** and signs every delivery with both,
so the receiver switches at its own pace and nothing is dropped in between.

## Delivery, retries, and switching off

The outbox relay hands each event to the webhook destination, which **records
one delivery row per subscribed endpoint** and sends nothing. A separate job,
every minute, claims what is due and sends it. Two steps on purpose: a slow
receiver must not hold up the relay for every other firm, and one endpoint
being down must not make the _event_ look undeliverable.

A claim is a lease. The row's next attempt is pushed two minutes out and the
attempt counted in one `UPDATE … FOR UPDATE SKIP LOCKED`, so a worker that
dies mid-request costs one retry and never a duplicate, and two workers cannot
claim the same row.

Failures — non-2xx, timeout, refused address — are retried on a widening
schedule: 30 s, 2 min, 8 min, 32 min, ~2 h, 6 h, 6 h; eight attempts in all
(`WEBHOOK_MAX_ATTEMPTS`). After the last the row is **EXHAUSTED and kept**. An
event that could not be delivered is a thing a person needs to see, not a thing
to drop.

Each exhausted delivery counts one consecutive failure against the endpoint;
any success resets the count. At `WEBHOOK_DISABLE_AFTER_FAILURES` (5) the
endpoint is **switched off by the platform**, with the reason on the row and an
audit entry, because a receiver nobody is running is not helped by another
thousand attempts and the log they would fill hides the next real failure.
Turning it back on re-schedules what was parked while it was off.

**Replay**: any delivery can be sent again. A replay is a new row pointing at
the one it repeats, marked `replay: true` in the body, so the log shows both
what happened and that somebody asked for it again.

## Where a webhook may point

A webhook is an HTTP request this platform makes to an address a customer
typed in — the textbook shape of server-side request forgery. So the
destination is checked **twice**:

- **When registered** (`checkDestination`): `https://` only (plain HTTP only
  with `WEBHOOK_ALLOW_HTTP`, for a local test receiver); no username or
  password in the URL; no fragment; no local names (`localhost`, `*.local`,
  `*.internal`); no literal private, loopback, link-local, multicast or
  documentation address — including `::ffff:` v4-mapped forms.
- **At delivery** (`vetAddress`): the name is resolved, **every** address it
  resolves to must be public, and the socket is told to connect to exactly the
  address that passed. A name with one public and one private answer is
  refused outright. This is what defeats DNS rebinding — a name that pointed
  somewhere public when the form was filled in and at `127.0.0.1` at delivery
  time.

Redirects are never followed. A webhook that redirects is a webhook pointing
somewhere the firm did not register. The response body is kept to one
kilobyte.

## Permission

`webhooks.manage`, on the tenant's ADMIN and BROKER_DEVELOPER roles, and
person-only: a long-lived key that could register an endpoint would be
exfiltration of every event from then on. Every route is `@SessionOnly()`.

## Routes

| Route                                        | What                                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| `GET /admin/webhooks/events`                 | The event types an endpoint may subscribe to                   |
| `GET /admin/webhooks`                        | Endpoints, with the secret's last four characters              |
| `POST /admin/webhooks`                       | Register. **The secret is in this response and nowhere else.** |
| `POST /admin/webhooks/:id/enabled`           | On or off. On re-schedules what was parked.                    |
| `POST /admin/webhooks/:id/rotate-secret`     | New secret, shown once; old one signs for a day                |
| `DELETE /admin/webhooks/:id`                 | Remove, with its log. The audit row remains.                   |
| `GET /admin/webhooks/:id/deliveries`         | The delivery log, newest first                                 |
| `POST /admin/webhooks/deliveries/:id/replay` | Send again                                                     |

## Not here, and why

- **`reconciliation.mismatch` and `security.alert` events.** §49 lists them.
  Neither is written to the outbox today, and a subscription to an event that
  is never produced is a subscription that reassures. They arrive when their
  producers write outbox rows, and then need nothing here.
- **A developer portal.** The OpenAPI document the API already serves is the
  reference; a page that renders it is Phase 12's remaining half.
- **Per-endpoint rate limiting.** A receiver that cannot keep up answers
  slowly or with 429, which is a failure and is retried on the schedule.

## Tests

- `packages/webhooks-core/src/*.test.ts` — signing, verifying, the schedule,
  the destination policy (75 tests)
- `apps/worker/src/jobs/webhook-sender.test.ts` — the HTTP half against a real
  socket; DNS vetting
- `apps/worker/test/integration/webhook-delivery.test.ts` — recording, sending,
  retrying, exhausting, auto-disable, tenancy
- `apps/api/test/integration/webhooks.test.ts` — registering, refusing,
  rotating, replaying, tenancy, audit
- `scripts/pentest.ts` — the SSRF addresses, over HTTP
