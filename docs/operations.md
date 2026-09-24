# Operations

Two things an operator needs: a way to stop the platform taking on new risk, and
one page that says whether anything needs them.

## The kill switch

```
POST /api/v1/operations/halt     { "reason": "..." }
POST /api/v1/operations/resume
GET  /api/v1/operations/trading-state
```

### Closing is always allowed

This is the rule the whole design turns on, and it is why the switch is called a
**halt** rather than a freeze.

| During a halt              |                   |
| -------------------------- | ----------------- |
| New position               | refused           |
| New resting order          | refused           |
| Modify a resting order     | refused           |
| Reverse a position         | refused           |
| **Close a position**       | **allowed**       |
| **Partial close**          | **allowed**       |
| **Cancel a resting order** | **allowed**       |
| **Move a stop or target**  | **allowed**       |
| Stop-out and SL/TP engines | **still running** |

A halt exists for the circumstances where something is wrong — a feed gone bad,
an engine behaving oddly, a market nobody understands. A switch that also blocked
closes would, in exactly those circumstances, leave every customer unable to get
out while the market moved against them. That is not a safety measure; it is the
thing safety measures exist to prevent.

The distinctions follow from the same principle:

- **Cancel yes, modify no.** A trader who wants their resting order gone must
  always be able to take it away. Moving it is a new decision about where risk
  sits.
- **Stops stay movable.** Somebody living through a market event most wants to
  _tighten_ a stop; refusing that would trap them in risk they were trying to
  reduce. The same door lets them widen one, which is a decision they could
  equally make by closing.
- **Reverse is refused up front**, not halfway. It is a close and then an open;
  letting it start would close the position, hit the halt on the open, and leave
  the trader flat when they asked to be the other way round.
- **Automatic closes keep working.** A stop-out is still a close.

The method the order path calls is named `assertMayOpenRisk()` rather than
something like `assertTradingAllowed()`, so a future caller cannot mistake it for
a general "is trading on" check and quietly block a close with it.

### It is stored, not remembered

In `system_settings`, with the actor who last changed it. Deliberately not an
environment variable: a kill switch that needs a deployment to flip is a kill
switch that will not be flipped in the minute it is needed.

The state is cached in the process because the order path consults it on every
submission, and a database round trip per order to read a value that changes
once a year is a cost paid a million times for nothing. The cache is written by
the same call that writes the row, and re-read at boot and on every set.

### Both directions are audited, with the reason

"Who stopped trading, when, and why" is the first question asked after any halt.
"Who started it again" is the second. An answer that lives only in somebody's
memory is not an answer.

A reason is **required** to halt and optional to resume — going back to normal is
the default state, and demanding a sentence for it would only produce empty ones.

### The refusal says what is happening

`TRADING_HALTED`, not `ACCOUNT_NOT_TRADEABLE`. A trader told "your account cannot
trade" when the whole platform is halted will reasonably think something is wrong
with _them_, and will call support to find out. The message names the reason and
says closing is still available.

The HTTP status is **503**, not 422: the request was fine and the service is
deliberately not taking it. A client that retries later is doing the right thing.

## The summary

```
GET /api/v1/operations/summary
```

Trading state, account and position counts, orders in the last hour and how many
were rejected, risk events in the last day, open integrity signals by severity,
and what the last reconciliation run found.

Deliberately a small number of counts rather than everything the system knows. A
dashboard with sixty figures on it is a dashboard nobody reads; the point of this
one is that a person glancing at it can tell within a second whether anything
needs them. Anything that does has somewhere to go and look further — the
integrity queue, the risk events, the reconciliation findings.

Every figure is a count over a bounded window. Nothing here scans a table without
a `WHERE`, because the page an operator opens during an incident must not be the
query that makes the incident worse.

## Permissions

| Route          | Needs                |
| -------------- | -------------------- |
| summary, state | `system.operations`  |
| halt, resume   | `system.kill_switch` |

`RISK_MANAGER` and `ADMIN` both hold the kill switch. Halting is a safety action,
and safety actions should not require finding the one person with the right title
at 3am. Both uses are audited.

## How this was verified

| Break                           | Result         |
| ------------------------------- | -------------- |
| The halt also blocks closing    | 2 of 12 failed |
| The halt state is not persisted | 1 of 12 failed |
| The halt refuses nothing        | 4 of 12 failed |
| Reverse is not guarded up front | 1 of 12 failed |

The first is the one worth having. Almost every test in that file exists to hold
one sentence in place: closing is always allowed.

## What this page used to list as not built

Both have been built since, and this section kept saying otherwise:

- **Per-order latency percentiles** (§50): `tp_order_stage_seconds` splits an
  order into received, validated, priced and executed, and
  `tp_client_clock_skew_seconds` records the client's own send time without ever
  trusting it. See [observability.md](observability.md), _The order timeline_.
- **Operational alerts** (§70): `docker/observability/alerts.yml` has a rule for
  every row of the table in [observability.md](observability.md), and that
  correspondence is checked by a test. What is still not here is **routing** —
  sending a firing alert to a pager or a phone is Alertmanager configuration
  for whoever runs the deployment, and this repository does not presume to
  write it. Until someone does, a firing alert is visible on Prometheus's alerts
  page and wakes nobody.
