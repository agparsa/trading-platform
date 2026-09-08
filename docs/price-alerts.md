# Price alerts

"Tell me when gold reaches 4600."

## What it is not

It is not a pending order, and the two are kept apart everywhere — different
table, different tab on the terminal, different sound. They look alike on
screen: both name an instrument, a direction and a level, and both wait. The
difference is that a pending order _does_ something when the price gets there.
Showing them in one list would invite a trader to read a line as an instruction
they had given, and that is the most expensive misreading this screen could
offer.

## Which price

There is no single price for an instrument, and picking one silently is how an
alert fires at a number the trader never saw. An alert names the half of the
book it watches:

| Source | What it is                                               |
| ------ | -------------------------------------------------------- |
| `BID`  | Where a long is marked and closed. The default.          |
| `ASK`  | Where a buy is filled.                                   |
| `MID`  | What most charts draw. Never a price anyone can deal at. |

`MID` is offered because it is what a chart shows, and is not the default for
exactly the reason it is offered.

## Reaching, not exceeding

The comparison is inclusive. "Tell me at 4600" is a request about _reaching_
4600; a trader who watches the price touch their number and hears nothing
concludes the feature is broken, and is right to.

Evaluation is over the **range** the market printed since the last pass, not the
latest tick — the same rule a stop-loss follows, for the same reason. A market
that jumps from 4590 to 4610 has passed 4600, and silence because no tick
printed exactly there helps nobody.

The price _reported_ is the price as it stands, not the extreme that triggered
the alert. The extreme has already gone; "gold reached 4600" next to a 4593 on
the same screen reads as a bug. The level asked about is carried alongside it,
so nothing is lost.

## Firing once

One alert fires once, which is why the row has a status rather than a boolean.
A level crossed back and forth in a volatile minute would otherwise produce a
notification per oscillation, which is how a trader learns to ignore them.
Re-arming is a deliberate act by the trader.

The write that claims an alert is a conditional update on `status = ACTIVE`, and
it happens **before** the notification. If the claim succeeds and the
notification then fails, the trader misses one alert. If it were the other way
round, the trader would get an alert per tick until the write succeeded — worse,
and much harder to stop once started.

Evaluation runs under its own leadership lease (`price-alerts`), so there should
not be a second evaluator at all. The conditional write is what keeps "should
not" from being a thing a trader is notified on the strength of.

## Its own lease, not the trigger engine's

Both watch prices, and they are deliberately separate loops. A stop-loss that
fires twice closes a position the trader still holds, so the trigger engine is
built to stop entirely rather than risk it. An alert that arrives twice is a
duplicate notification, and one that never arrives is a nuisance. Sharing a
lease would tie alerts to the engine's caution — no alerts during any incident
that costs the engine its lease — for no gain, because the two never conflict.

## Limits

`MAX_ACTIVE_ALERTS_PER_USER` is 200, checked when an alert is created. The sweep
reads every active alert on an instrument on every pass; one person with fifty
thousand alerts on XAUUSD is not that person's problem, it is everybody's,
because it is the tick path. A single pass also reads at most 5,000 alerts per
instrument; the excess is picked up by the next pass, and alerts are not ordered
relative to each other, so there is nothing to be unfair about.

## Notifications

Alerts raise `price.alert`, in the `PRICE_ALERT` category — its own, and a
**mutable** one. Unlike `RISK_ALERT`, nothing happens to the account if a level
is missed, and a trader who has decided they no longer want to hear about levels
is entitled to that. A margin call is not a matter of taste; a level is.

The mobile sound is two rising notes an octave apart, quiet and unhurried,
deliberately unlike `risk_warning`: a chime that sounds like a margin call would
teach traders to dread a message they asked for.

## API

| Route                 | Permission   | What                                       |
| --------------------- | ------------ | ------------------------------------------ |
| `GET /alerts`         | self-service | Your alerts, optionally filtered by status |
| `POST /alerts`        | self-service | Watch a level                              |
| `DELETE /alerts/{id}` | self-service | Stop watching one                          |

Self-service on every route: these are a person's own watchlist notes, and a
long-lived API key has no business setting or clearing them.

`DELETE` cancels rather than deletes. A triggered alert is the record of a
notification the trader received, and a fired alert that leaves no trace is a
support conversation nobody can settle.

Every route is scoped to the caller inside the query, not by checking ownership
after a read. An alert id is a UUID somebody might paste, and "cancel by id"
that trusts the id is how one trader silences another's.
