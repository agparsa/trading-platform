# Notifications

## Why they are rows and not frames

A socket frame reaches whoever is looking. A margin call that only existed as a
frame is a margin call the trader who stepped away never got — and stepping away
is exactly when it matters.

So a notification is written to the database first. The bell reads it, the
toast strip nudges about it, and an email transport would too. All three are
readers of one row.

## The three surfaces, and what each is for

| Surface               | What it is                                              |
| --------------------- | ------------------------------------------------------- |
| `notifications` table | the record. Survives the browser being shut.            |
| The bell              | the record, read. What is here when you come back.      |
| A toast               | the nudge. Appears, fades, is not a record of anything. |

If the only place a trader could learn they were on margin call were a strip
that faded after eight seconds, the platform would have told them nothing.

## Raising one

`NotificationsService.raise` publishes a BullMQ job and **never throws**. It is
called from the risk path, and a queue that is briefly unreachable must not fail
a stop-out: the trade is the thing that matters and the notice is about it. This
is the same rule `EventsService.publish` follows, for the same reason.

The worker's processor writes the row, then pushes it to the person's
registered devices. `emailedAt` exists and stays null, because there is no email
transport in that process and marking a row as emailed when nothing was sent
would be worse than not having the column.

## Duplicates

`dedupeKey` carries a unique constraint, and the risk path builds one from the
account, the state and the minute. Transitions are already de-duplicated in
memory, but that memory belongs to one process: two API instances watching the
same account would each see the crossing. The key makes the second a no-op at
the database rather than a second bell.

The processor treats losing that unique-constraint race as the expected outcome,
not as a failure — it looks up the winner and reports it.

**Push happens only for a row the processor actually created.** That single
condition is what satisfies the specification's duplicate-event requirement for
the whole platform: a second attempt finds the row present, returns
`created: false`, and never reaches the push path. There is deliberately no
push-side deduplication — a second mechanism could disagree with the first, and
the way that failure presents is a trader's phone buzzing twice for one fill.

Both the socket frame and the push carry the same `eventId`, so a client that
has already handled the frame discards the push instead of showing it again and
playing the sound again. When a producer supplies no event id, the
notification's own id is used: still stable, still unique, still processed once.

## What raises one today

| Kind                     | When                                    | Category          |
| ------------------------ | --------------------------------------- | ----------------- |
| `position.opened`        | a position opens                        | `TRADE_OPENED`    |
| `position.closed`        | a position closes manually              | `TRADE_CLOSED`    |
| `position.partial_close` | part of a position closes               | `TRADE_CLOSED`    |
| `position.stop_loss`     | a stop loss or trailing stop fires      | `STOP_LOSS`       |
| `position.take_profit`   | a take profit fires                     | `TAKE_PROFIT`     |
| `position.modified`      | SL or TP changed                        | `TRADE_MODIFIED`  |
| `order.cancelled`        | a resting order is cancelled or expires | `ORDER_CANCELLED` |
| `risk.margin_call`       | an account crosses into margin call     | `RISK_ALERT`      |
| `risk.stop_out`          | an account reaches its stop-out level   | `RISK_ALERT`      |

The trading rows come from **one subscriber** on the domain event bus, not from
eight call sites. Orders and positions publish from eight places and the trigger
engine will add more; a `raise(...)` beside each is the change that gets
forgotten at the ninth, and a missing notification is invisible until somebody
complains that their stop loss fired without telling them.

Subscribing there also inherits the guarantee §16 asks for. Those events are
published _after the transaction commits_ — so there is no path from a rejected
or rolled-back order to a notification, because there is no event.

`ORDER_FILLED` deliberately raises nothing. Every fill in this platform opens a
position and both events are published together; notifying on both would buzz
the phone twice for one action.

Recovering to normal deliberately raises nothing either. It is good news that
needs no chasing, and a bell that rings for every recovery teaches people to
ignore it. The _toast_ does mention a recovery, because it replaces the warning
still on screen.

### Two instances, one notice

A handler registered on the bus runs on the instance that published _and_ on
every instance that receives the envelope over Redis, so both raise the same
notice. The `dedupeKey` is the envelope's own `eventId` — generated once at
publication and carried with it — so the second job is a no-op at the database.
The same mechanism that already collapses two producers noticing one margin
call, reused rather than reinvented.

The envelope carries `tenantId` for the same reason. A handler on another
instance has no request behind it and therefore no tenant scope; it enters one
from the envelope. An event with no tenant is dropped loudly rather than filed
under a default, because filing it would put one firm's trade in another firm's
notification list.

## Reading

Every route on `NotificationsController` is scoped to the caller in its own
query. There is no notion of reading somebody else's notifications, so there is
no permission that could grant it and no code path that could be talked into it.

## Push

`PushProvider` is a port with two implementations, chosen at worker boot from
`PUSH_PROVIDER`:

| Value  | Provider           | What it does                                        |
| ------ | ------------------ | --------------------------------------------------- |
| `none` | `NoopPushProvider` | records every push as **SKIPPED**, and says so once |
| `fcm`  | `FcmPushProvider`  | Firebase Cloud Messaging, HTTP v1                   |

The no-op records `SKIPPED` rather than `SENT`, and that is not fussiness. A
no-op reporting success would make the Admin panel's delivery statistics — the
numbers an operator uses to answer "are our notifications working" — read 100%
on a deployment that has never sent a single push.

`PUSH_PROVIDER=fcm` without `FCM_SERVICE_ACCOUNT_JSON` or
`SECRET_ENCRYPTION_KEYS` refuses to boot. Both are configuration mistakes whose
only symptom is silence, which is the hardest kind to notice.

### iOS goes through FCM too

FCM forwards to APNs when the `apns` block is present, so one credential and one
code path cover both platforms. Talking to APNs directly would mean a second
provider, a second key format and a second set of error semantics for no gain
this platform can currently name.

### Which failures kill a token

From Firebase's documented error codes, and the distinction is expensive in both
directions — retrying a dead token burns quota, deleting a live one silently
stops a trader's margin calls:

| Code                     | What we do                              |
| ------------------------ | --------------------------------------- |
| `UNREGISTERED`           | mark the device rejected                |
| `SENDER_ID_MISMATCH`     | mark the device rejected                |
| `QUOTA_EXCEEDED`         | retry with jittered exponential backoff |
| `UNAVAILABLE`            | retry                                   |
| `INTERNAL`               | retry                                   |
| `THIRD_PARTY_AUTH_ERROR` | stop; an operator must fix credentials  |
| `INVALID_ARGUMENT`       | stop, and **leave the token alone**     |

`INVALID_ARGUMENT` is the interesting one. Firebase returns it both for "that is
not a token" and for "your message was malformed". Treating it as a dead token
would unsubscribe a user because of our own bug, so it stops the retry loop
without touching the device and logs which message failed.

A network error or an unreachable token endpoint is classified `RETRY`, never
`DROP_TOKEN`. A brief outage must not be able to unsubscribe the estate.

### Delivery records

One `push_deliveries` row per notification per device, upserted so a retry
updates the attempt rather than writing a second row. `SKIPPED` rows are written
for devices the user's preferences excluded, because "we chose not to" and "we
tried and failed" are different answers to the same support question and only
one of them is a bug.

`SENT` means FCM accepted the message. It does not mean the phone displayed it,
and no push provider can tell us that — which is why the admin view says "sent"
rather than "delivered".

## Preferences

Per-category switches with master overrides, in `@tp/push-core` so that the API
serving the settings screen and the worker doing the delivery cannot disagree
about them. Two implementations would eventually drift, and the way that
presents is a settings screen showing an off switch while the notifications keep
arriving.

The precedence, in order:

1. An unmutable category — `SECURITY_ALERT`, `RISK_ALERT` — is delivered in-app
   and by push, always. The API **refuses** an attempt to turn one off rather
   than accepting it and ignoring it.
2. Otherwise the master switches win over the per-category ones, so turning push
   off means off without rewriting ten rows and without losing what those rows
   said.
3. Quiet hours withhold push only, and never for an unmutable category. A
   stop-out at three in the morning is exactly the notification a person set
   quiet hours to avoid and exactly the one they need.

A missing preference row means **the default for that category, not off**.
Reading it as off would mean every category added in future is born muted for
the entire existing user base, and nobody would notice until an incident.

Quiet hours are stored as minutes from midnight plus an IANA timezone, and
setting them without a timezone is refused. Assuming UTC would silence a trader
in Tehran between 03:00 and 10:00 local.

## Devices

See [sounds.md](sounds.md) for what a client plays, and the `Device` model for
how a push token is stored. In short: keyed on a client-generated installation
id rather than the token, because FCM and APNs rotate tokens unasked and keying
on the token means a rotation creates a second row and the trader hears
everything twice. The token itself is sealed with AES-256-GCM bound to its own
row, and never appears in any API response.
