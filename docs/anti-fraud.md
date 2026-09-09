# Integrity signals

This engine notices patterns in trading activity and asks a person to look at
them. It does not decide anything about anybody.

That distinction is the whole design, and every choice below follows from it.

## Signals, not verdicts

A signal says **what was observed**: "14 orders in 2s", "an order 40× this
account's median size". Not "order flooding", not "suspicious sizing", and never
"fraud".

The reader decides what it means. A burst of orders is a scalper, a
misconfigured bot, a market maker, or an attack, and no threshold can tell which.
An engine that phrases arithmetic as an accusation has accused a customer on
the strength of a constant somebody picked.

Every signal carries the evidence it was made from, because a signal a person
cannot check is a signal they have to trust — and nobody should have to trust an
automated accusation.

### Severity stops at HIGH

Nothing this engine produces is `CRITICAL`. A pattern in trading activity is
never, on its own, the most serious thing this platform can say. `CRITICAL`
belongs to a balance that is not backed by the ledger — where the system knows
something is actually wrong rather than merely unusual.

### `FALSE_POSITIVE` is a first-class outcome

```
OPEN → ACKNOWLEDGED → INVESTIGATING → RESOLVED
                                    → FALSE_POSITIVE
```

A detector that is never wrong has not been looked at closely enough. Without a
way to say "we looked, and this was nothing", every dismissal has to be filed as
a handled incident, nobody can tell how noisy a detector actually is, and
operators start closing things quietly instead.

## What it may see

Orders, positions and exposure. Records this platform already keeps because
trading created them.

It collects **nothing** about a person that placing an order did not already
require: no device fingerprint, no browsing history, no keystroke timing, no
location, no camera, no microphone, no files. The engine's usefulness is not
worth becoming surveillance for, and an anti-fraud system that watches people
rather than trades has changed what the product is.

## The detectors

| Signal                     | Notices                                    | Severity   |
| -------------------------- | ------------------------------------------ | ---------- |
| `ORDER_BURST`              | orders faster than a person places them    | med / high |
| `REPEATED_REJECTIONS`      | an order that keeps being refused          | low        |
| `DUPLICATE_ORDER_ATTEMPTS` | the same order sent again and again        | medium     |
| `RAPID_OPEN_CLOSE`         | positions held for seconds, repeatedly     | low        |
| `VOLUME_SPIKE`             | an order far above this account's own norm | med / high |
| `CONCENTRATION`            | most of the book in one instrument         | low        |

Every threshold is configuration. A threshold that needs a deployment to change
is a threshold that gets worked around, and the right value for "too many
orders" depends on the desk, the instrument and the hour.

### Deliberate choices inside them

- **The densest window, not the last one.** A burst that straddles a fixed
  window's boundary is a burst a fixed window cannot see.
- **The median, not the mean**, for what an account's normal size is. One outlier
  drags a mean towards itself and helps hide the next one.
- **The account's own norm**, not a platform-wide figure. A size that is
  unremarkable on one desk is extraordinary on another; a fixed number would flag
  every large account continuously and never notice a small one behaving
  strangely.
- **A minimum sample** before there is a norm at all, so an account's second ever
  trade is not flagged for being bigger than its first.
- **Two floors on concentration** — a minimum book size and at least two
  instruments — because a single position is 100% concentrated by arithmetic and
  by nothing else.
- **Exposure at entry price**, not at the mark. A signal that appears and
  disappears as a quote moves is noise, and the question is what was taken on,
  not what it is worth this second.
- **Rapid open-close is `LOW`.** It is what scalping looks like from the outside,
  and scalping is a strategy rather than an offence.

- **Rapid cancel/replace is counted per order, not per account.** Twenty
  amendments spread over twenty orders is a busy desk; twenty on one order is
  somebody doing something to that order, and only the second is worth a
  person's time. It also ignores `MODIFY_REQUESTED` without a `MODIFIED`: an
  amendment the engine refused is not churn on the book, and counting it would
  report a broken client as an integrity concern.

### What is not detected, and why

§46 also lists client/server clock anomalies, market-data sequence anomalies,
device and IP change, and execution/ledger mismatches.

**Execution/ledger mismatch** is [reconciliation](./reconciliation.md), which
does it properly and should not be done twice.

**Device and IP change** is already detected, and is in the _security_ feed
rather than here: `SIGN_IN_NEW_DEVICE` carries the address and the user agent
and reaches the account owner. Duplicating it as an integrity signal would put
one event in two queues with two review states, and the account owner is the
person best placed to say whether a new device is theirs.

**Clock skew** is recorded but deliberately not a detector.
`tp_client_clock_skew_seconds` (§50) is an _aggregate_: a population whose skew
moves together is a real signal and is visible on the dashboard. Turning it into
a per-account detector would mean storing every trader's clock offset over time
— a profile of a person's device that trading never required, which is exactly
the line this engine does not cross. The interesting question ("did this fleet
of clients suddenly change together?") is answered by the metric; the
uninteresting one ("is this person's laptop clock wrong?") is not worth a file
on them.

**Market-data sequence anomalies** have no input. There is no client sequence
number on an order, and the venue sequence on `BrokerInboundEvent` is the
venue's ordering, not a client's. Building a detector over an identifier this
platform does not receive would be fabricating one.

A detector that cannot fire is worse than an absent one: it looks like coverage
on a dashboard and quietly reassures everybody.

## The engine is never in the execution path

Nothing here runs while an order is being placed, filled or closed. It reads
records afterwards, on a schedule or on demand, and a failure in it can delay a
review — never a trade.

An anti-fraud engine that can stop a fill is an anti-fraud engine that will one
day stop a legitimate one, at the worst possible moment, for a reason nobody can
explain to the customer.

## One signal, many sightings

A pattern that keeps recurring is the **same** signal seen again: one row per
account and code, with an occurrence count, a first-seen and a last-seen. A
thousand duplicate rows would bury the one fact a reviewer needs — how persistent
this is — under a thousand copies of it.

Every individual sighting is still appended to the signal's event log.

**A recurrence never reopens a dismissed signal.** Re-raising something an
operator marked `FALSE_POSITIVE`, every time the pattern repeats, overrules their
judgement with a threshold and trains them to stop looking. The recurrence is
recorded; the status is theirs.

## Evidence is never overwritten

`integrity_signal_events` is append-only: `RAISED`, `RECURRED`, `STATUS_CHANGED`,
each with its evidence, its actor and its timestamp. Nothing is ever updated.

"What did this look like when it was raised" has to stay answerable after
somebody has reviewed and closed it. Evidence that can be overwritten is evidence
that cannot be relied on.

## How this was verified

Every detector has a positive fixture and a negative one, and the negative is the
important half — built to sit as close to the threshold as ordinary trading
plausibly gets. There is also a whole-engine test that a busy, ordinary trading
day produces **no signals at all**: an engine that cannot stay quiet about
normal work has nothing useful to say about anything else.

Each rule was then broken deliberately:

| Break                                          | Result         |
| ---------------------------------------------- | -------------- |
| No minimum sample before a volume norm exists  | 1 of 29 failed |
| Mean instead of median                         | 2 of 29 failed |
| A single position counts as concentration      | 1 of 29 failed |
| No minimum book size for concentration         | 1 of 29 failed |
| A fixed last window instead of the densest run | 1 of 29 failed |
| Hold time ignored for rapid open-close         | 1 of 29 failed |
| A recurrence creates a new row                 | 3 of 9 failed  |
| A recurrence reopens a dismissed signal        | 1 of 9 failed  |
| A status change overwrites the history         | 1 of 9 failed  |
| Dormant accounts scanned too                   | 1 of 9 failed  |
