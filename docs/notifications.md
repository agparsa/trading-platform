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

The worker's processor writes the row. Delivery today is **in-app only** —
`emailedAt` exists and stays null, because there is no email transport in that
process and marking a row as emailed when nothing was sent would be worse than
not having the column.

## Duplicates

`dedupeKey` carries a unique constraint, and the risk path builds one from the
account, the state and the minute. Transitions are already de-duplicated in
memory, but that memory belongs to one process: two API instances watching the
same account would each see the crossing. The key makes the second a no-op at
the database rather than a second bell.

The processor treats losing that unique-constraint race as the expected outcome,
not as a failure — it looks up the winner and reports it.

## What raises one today

| Kind               | When                                  |
| ------------------ | ------------------------------------- |
| `risk.margin_call` | an account crosses into margin call   |
| `risk.stop_out`    | an account reaches its stop-out level |

Recovering to normal deliberately raises nothing. It is good news that needs no
chasing, and a bell that rings for every recovery teaches people to ignore it.
The _toast_ does mention a recovery, because it replaces the warning still on
screen.

## Reading

Every route on `NotificationsController` is scoped to the caller in its own
query. There is no notion of reading somebody else's notifications, so there is
no permission that could grant it and no code path that could be talked into it.
