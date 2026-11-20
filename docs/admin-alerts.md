# Admin alerts

Thresholds an operator sets on counts the platform keeps, and the alerts they
raise. `/admin/alerts`, `system.operations` throughout. Price alerts for
traders are a different feature — see `price-alerts.md`.

## What can be watched

Every metric is a count the database already holds (`ADMIN_ALERT_METRICS` in
`@tp/shared-types`), so it is exact, cheap to read every minute and needs no
price — a market-data outage cannot become an alert storm.

| Metric                  | Counts                                                          |
| ----------------------- | --------------------------------------------------------------- |
| `WITHDRAWALS_WAITING`   | withdrawal requests requested or under review                   |
| `VERIFICATIONS_WAITING` | identity verifications pending or under review                  |
| `RECONCILIATION_OPEN`   | reconciliation findings open, acknowledged or investigating     |
| `RISK_EVENTS_1H`        | risk events recorded in the last 60 minutes                     |
| `REJECTED_ORDERS_1H`    | orders rejected in the last 60 minutes                          |
| `CONNECTIONS_FAILING`   | enabled venue connections disconnected, refused or rate-limited |
| `REGISTRATIONS_24H`     | people who opened an account in the last 24 hours               |

## How a rule raises

The worker's `admin-alerts` job (`ADMIN_ALERTS_CRON`, every minute) finds every
firm with an enabled rule and reads each firm's rules **inside that firm's
scope**, so a count is only ever of that firm's rows (tested). For each rule:

- the reading is stored on the rule (`lastValue`, `inBreach`), so the panel
  shows where every rule stands;
- comparison is strict — “above 10” fires at 11;
- it raises on the **first** reading over the line, and again while it stays
  over only once its **quiet period** has passed (`shouldRaise`) — a rule left
  breached does not fill the list every minute;
- a breach that clears and comes back raises at once;
- an alert copies the rule's name, condition and reading, so editing the rule
  later does not rewrite what the alert said.

A rule that can never fire (a count below zero) or watches an unknown metric
is refused when saved; an unknown metric met by the worker (an older version
reading a newer rule) is skipped and logged, not read as zero.

## Working through them

Raised alerts stay open until somebody acknowledges them, optionally with a
note; each acknowledgement and each rule change is audited. The admin
overview shows a banner while any are open.

## Not covered

Not pushed or emailed — shown in the panel and on the overview. No metric that
needs a price (exposure, margin level). The deployment's own operational
alerts (`docker/observability/alerts.yml`) are for whoever runs the servers and
are separate.
