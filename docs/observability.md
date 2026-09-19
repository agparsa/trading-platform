# Observability

## Logs

Pino, structured JSON, one line per request, with the request id threaded from
the incoming `X-Request-Id` header (or generated). The same id appears in the
error envelope and the audit row, which is what turns "my order was rejected at
09:27" into a single query.

Pretty-printing is development only. Credentials are removed, not masked — see
[security.md](./security.md).

## Metrics

Prometheus at `/metrics`. Declared in `MetricsService` so later phases increment
existing names instead of inventing new ones and breaking dashboards.

| Metric                             | Type      | Labels                |
| ---------------------------------- | --------- | --------------------- |
| `tp_http_requests_total`           | counter   | method, route, status |
| `tp_http_request_duration_seconds` | histogram | method, route         |
| `tp_market_ticks_total`            | counter   | symbol                |
| `tp_orders_submitted_total`        | counter   | symbol, type, outcome |
| `tp_execution_latency_seconds`     | histogram | symbol                |
| `tp_websocket_events_total`        | counter   | event                 |

Plus Node defaults under the same `tp_` prefix (event-loop lag, heap, GC).

`tp_execution_latency_seconds` measures acceptance → fill, by instrument. It is
the same span as `tp_order_stage_seconds{stage="executed"}` cut by symbol rather
than by stage, and that is the point: one illiquid instrument dragging is
invisible in an aggregate. It is the number that tells you whether the engine is
healthy under load, and the one that will regress first.

**Three of the six were declared and never fed** — `tp_http_requests_total`,
`tp_http_request_duration_seconds` and `tp_execution_latency_seconds` — from the
first phase until now. Six requests through a running instance produced a
`# HELP` line and zero samples. That is worse than a missing metric: Prometheus
answers a query against it with *no data* rather than an error, a panel draws an
empty chart rather than a broken one, and an alert on a series that never exists
never fires and never says why. `ExecutionLatencyHigh` and `RequestsShed` were
both in that state, and four panels of the shipped dashboard.

`declared-metrics.test.ts` now checks both directions: every metric declared in
`MetricsService` has something that writes to it, and every metric the shipped
alerts and dashboard query is one this build exports.

The two HTTP metrics are recorded by Express middleware mounted **ahead of the
drain**, not by a Nest interceptor: admission control answers a shed request
itself without calling `next()`, and those 503s are exactly what `RequestsShed`
counts. The `route` label is the route *pattern*, never the URL — a label value
is a time series, and `/api/v1/accounts/<uuid>/positions` would mean one series
per account for ever, with account identifiers inside a store that has its own
access rules and its own retention.

## Dashboards and alerts (§63)

`docker/observability/` and `docker-compose.observability.yml` ship Prometheus
and Grafana as a third compose file, added to the command when wanted:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml \
  -f docker-compose.observability.yml --env-file .env.production up -d
```

Prometheus scrapes the serving and ingest API processes over the compose
network (the worker exposes no metrics endpoint; its work is visible through
the outbox and reconciliation gauges). Grafana provisions itself from files in
this repository — the datasource, the "Trading platform" dashboard and the
alert rules — so a fresh host gets the same screens and a threshold change is a
reviewed commit. It listens on the loopback interface only
(`GRAFANA_PORT`, default 3001); reach it over an SSH tunnel:

```bash
ssh -L 3001:127.0.0.1:3001 tp-server   # then http://127.0.0.1:3001
```

`GRAFANA_ADMIN_PASSWORD` must be set in `.env.production` before that file will
start; generate it, do not reuse another secret. It is a separate file rather
than a profile because compose interpolates every file it is given, profiles
included — a required password in the main file stopped every `up`, `ps` and
`logs` on a host that had not set it.

The dashboard's twenty-one panels chart the metric set above plus what later
phases added — order pipeline stages, requests shed as overloaded, tick →
frame latency, realtime pass lag and valuations deferred, leadership leases
and transitions, event-loop lag and heap. A deployment test checks that every
`tp_` metric the dashboard or an alert names is one `MetricsService` declares,
so a panel can never be a flat line for a metric nobody emits.

The alert rules in `docker/observability/alerts.yml` implement the table under
*What to alert on* below, one rule per row, and that correspondence is checked
rather than asserted. Thresholds are starting points for a two-core deployment;
the reasoning beside each is the part to keep when they are tuned. Routing them
to a pager is Alertmanager configuration this repository does not presume to
write.

## Health

`/health` — liveness, no dependencies touched.
`/ready` — readiness, reports database and Redis status with measured latencies.
`/health/market` — the feed. Alert on it; do not route on it.
`/health/jobs` — the scheduled work. Alert on it; do not route on it.
`/health/tenancy` — whether row-level security applies to the connection this
API uses. `TenantIsolationAbsent` alerts on it, selecting
`tp_tenant_isolation{configured="true"}`; on a single-role deployment `0` is the
documented posture and carries `configured="false"`.

**These paths sit outside the API prefix, and that is a list somebody has to
maintain.** It is `HEALTH_ROUTES` in `health.controller.ts`, and for a week it
was a literal in `main.ts` that had not been updated — so `/health/jobs`
answered 404 while the probe itself was alive at `/api/health/jobs`. A test
compares the two lists in both directions now, and `verify:production` says so
by name rather than reporting the 404 as an old build.

The last two are separate from readiness on purpose. A process pulled out of the
load balancer because the upstream feed stopped, or because a nightly sweep did
not run, is a process that can still serve history, account state and the
ledger — and taking it away removes the screens people need in exactly the
moment they need them.

Health indicators report `error.name` rather than `error.message`, because
driver messages contain connection strings.

## What to alert on

**Every row names the rule that implements it**, and
`scripts/deployment.test.ts` reads this table against
`docker/observability/alerts.yml` in both directions: a row naming a rule that
does not ship fails, and a rule not named here fails too.

That check exists because this table spent its whole life as prose. It listed
dead-letter depth, the three scheduled-job signals and the isolation gauge under
a heading that says *alert on this* — and **none of them had a rule**. The file
shipped nine alerts, the table asked for nine signals, and they were a different
nine. Dead-letter depth was the worst of them: there was no series at all, so an
operator following the row had to open Redis by hand.

| Signal                                        | Rule                       | Why                                                              |
| --------------------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| An API process unreachable                    | `ApiTargetDown`            | The instance is not there at all. Readiness itself is the container healthcheck's job; this is the coarser question |
| `tp_market_feed_age_ms` over ten seconds      | `MarketFeedStale`          | Orders are being refused `STALE_QUOTE`, or soon will be           |
| `tp_market_ticks_total` flat                  | `MarketFeedFlat`           | The feed died; quotes are going stale                             |
| Nothing holds the trigger-engine lease        | `NoLeaderForTriggerEngine` | Stops and take-profits are not being evaluated anywhere            |
| `tp_execution_latency_seconds` p99 rising     | `ExecutionLatencyHigh`     | The engine is falling behind the market                           |
| Requests shed as overloaded                   | `RequestsShed`             | Admission control is declining; add a serving instance            |
| Ledger vs `accounts.balance` drift            | `ReconciliationFindingsOpen` | Reconciliation found a discrepancy — the most serious alert here |
| Market-data integrity signals open            | `IntegritySignalsOpen`     | The feed is producing prices the gate refused                     |
| Valuations deferred for ten minutes           | `RealtimeValuationsDeferred` | Screens are refreshing less often than the interval             |
| Event-loop lag p99 over half a second         | `EventLoopLag`             | The process is saturated                                          |
| `tp_dead_letter_depth` > 0                    | `DeadLetterNotEmpty`       | A financial job failed and is waiting for a human                 |
| `tp_scheduled_job_late` > 0                   | `ScheduleLate`             | A schedule has stopped, is failing, or was never registered — the one failure here that produces no error at all |
| `tp_scheduled_job_age_ms` = -1                | `ScheduleNeverSucceeded`   | That job has run and has never succeeded. Usually it is failing every time |
| `tp_scheduled_job_late{job="backup"}`         | `BackupLate`               | The backup container has stopped or is failing. Its dumps are the only thing standing between a lost primary and a lost business |
| `tp_tenant_isolation{configured="true"}` = 0  | `TenantIsolationAbsent`    | The deployment asked for row-level security and does not have it. The `configured` label is what makes this expressible: without it the reading is indistinguishable from the single-role posture, where `0` is correct |
| A job **missing** from `/health/jobs`         | — `verify:production`      | It has never run once — no row exists. A gauge cannot say this, because there is nothing to label |

Failed jobs are retained deliberately (`removeOnFail: false`): a failed financial
job must stay visible until someone has looked at it.

The two scheduled-job signals are the ones worth adding first if this list is
being implemented from scratch. Everything else here alerts on something going
*wrong*; those two alert on something not happening at all, which is the failure
mode nothing else in this platform can see. `docs/worker.md` has the mechanism
and the three decisions behind it.

## Leadership (Phase 8)

Some loops must run in exactly one process: the trigger engine, which closes
positions from price movement, and market ingestion, which writes candles. Two
of either is not a doubled workload — it is one position stopped out twice and
one minute's volume counted twice.

Until Phase 8 that was arranged by setting `TRIGGER_ENGINE_ENABLED=true` on one
container. Nothing enforced it: a rolling deploy overlaps old and new, and
`--scale api-ingest=2` typed once makes it permanent. Now the flag means "this
instance may contend", and a lease in `leader_leases` decides which contender
acts.

| Metric                        | Type    | Labels           |
| ----------------------------- | ------- | ---------------- |
| `tp_leader_lease`             | gauge   | loop             |
| `tp_leader_transitions_total` | counter | loop, transition |

`sum(tp_leader_lease) by (loop)` is the alert worth having, and it is worth
having in both directions:

| Reading | Meaning                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1`     | Normal.                                                                                                                                            |
| `0`     | Nothing is running the loop. For `trigger-engine` that means stop-losses are not firing, which is an incident from the first second.               |
| `> 1`   | Two instances believe they lead. Should be impossible outside the stall window described in `LeadershipService`; treat a sustained reading as one. |

### Which container contends

`MARKET_INGEST_ENABLED`, `TRIGGER_ENGINE_ENABLED` and `PRICE_ALERTS_ENABLED` are
set to `true` on `api-ingest` and `false` on `api` (`docker-compose.prod.yml`).
That is a placement decision, not a safety one — the lease is what makes a
second instance safe. The flags keep the per-tick work off the containers
answering traders, and leave `api-ingest` free to be scaled to two for handover
without either replica having to be told which of them is in charge.

### After an unclean stop

A leader that is stopped politely hands its lease back, so a successor takes
over within one renewal interval. A leader that is _killed_ — SIGKILL, a lost
machine, a container OOM — cannot, and the lease has to lapse on its own. Until
it does, nothing ingests prices and nothing evaluates stop-losses: up to
`LEADER_LEASE_TTL_MS`, ten seconds by default.

This is visible and it is meant to be. It shows up as quotes that stop
advancing and then resume, and — if anything tries to trade in that window — as
`STALE_QUOTE`, which is the platform correctly refusing to fill on a price it
knows is old. It is the price of the lease, and the alternative is not "no
window" but "two engines during the window", which is worse.

If ten seconds is too long for a deployment, `LEADER_LEASE_TTL_MS` is the knob —
but lowering it makes renewals less tolerant of a slow database, and a lease
that flaps under load is worse than one that takes a moment to move.

A rising `tp_leader_transitions_total` with no deploy means the lease is
flapping — usually a database slow enough that renewals miss twice. That is
worse than one instance holding it badly, because each handover re-warms an
empty tick window.

`GET /admin/leadership` (`system.operations`) shows the current holders, their
terms, and whether the instance answering is one of them. It is read-only: the
way to move leadership is to stop the instance holding it. Anything else is a
person and a lease disagreeing about who is in charge.

## Latency (Phase 8, §34)

| Metric                         | Type      | Labels          |
| ------------------------------ | --------- | --------------- |
| `tp_tick_to_pnl_seconds`       | histogram | —               |
| `tp_tick_to_socket_seconds`    | histogram | —               |
| `tp_quote_age_seconds`         | histogram | symbol, purpose |
| `tp_order_ack_seconds`         | histogram | outcome         |
| `tp_realtime_pass_lag_seconds` | histogram | —               |
| `tp_lease_wait_seconds`        | histogram | loop            |

Every one of these is measured from the **tick's own timestamp**, not from the
start of the stage reporting it. That is the point: per-hop timings can all look
healthy while a trader's screen is four seconds behind, because what puts it
four seconds behind is the queueing _between_ the hops, which no hop measures.

`tp_tick_to_pnl_seconds` is measured against the **oldest** tick the pass has
not yet answered for, never the newest. A backlog makes the newest tick
_younger_, so measuring against it would report a healthy platform exactly when
it is furthest behind.

`tp_quote_age_seconds` is not feed health. `tp_market_feed_age_seconds` says
whether prices are arriving; this says how old the price was at the moment
something was decided on it. They come apart precisely when it matters: a feed
that is healthy overall while one instrument has not printed for a minute reads
as fine on the first and badly on the second, and it is the second that
describes the fill.

`tp_order_ack_seconds` counts refusals as well as fills, under an `outcome`
label. A rejection that takes two seconds is still two seconds of a trader not
knowing, and refusals are the case most likely to be slow — a refusal usually
lands _after_ the risk checks, not before them.

| Reading                                                               | Meaning                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `tp_tick_to_socket_seconds` p99 rising, `tp_tick_to_pnl_seconds` flat | Fan-out, not valuation. Too many sockets on one instance.        |
| Both rising together                                                  | Valuation. The database, or too many exposed accounts per pass.  |
| `tp_realtime_pass_lag_seconds` rising                                 | The loop itself is behind; passes are overrunning their cadence. |
| `tp_lease_wait_seconds` p99 approaching `LEADER_RENEW_INTERVAL_MS`    | Leases are about to start flapping.                              |

### The order timeline (§50)

`tp_order_ack_seconds` says a submission took 300ms. `tp_order_stage_seconds`
says whether that was the risk valuation, the venue, or a row lock — three
incidents with three different fixes.

| Stage       | Ends when                                                      |
| ----------- | -------------------------------------------------------------- |
| `received`  | The request reached the order path.                            |
| `validated` | Instrument, session, account status, throttle and volume pass. |
| `priced`    | A fresh quote, the conversion rate and the margin are known.   |
| `executed`  | The fill — or the refusal — is written.                        |

There is deliberately no `responded` stage. The time between the last write and
the bytes leaving the process is `tp_http_request_duration_seconds` already, and
adding it here would be the same milliseconds under two names.

Refusals are recorded, and only for the stages they reached. A refusal usually
happens _after_ the risk valuation rather than before it, so the path ending in
"no" is often the slower of the two, and recording only successes would leave
the expensive half of the traffic unmeasured. An unmarked stage is absent rather
than zero — a spike of zeros would quietly move that stage's median.

The full per-order breakdown is also written to one `Order timeline` log line at
`debug`, so a specific slow order can be looked up rather than inferred from a
percentile.

`tp_client_clock_skew_seconds` is recorded from an optional `x-client-sent-at`
header and **never used to decide anything**. A browser's clock is whatever the
person set it to, so it cannot go near a fill price or a session check. The
value is bounded at ±24 hours before it is recorded, so nobody can push the
histogram's sum wherever they like. What it is good for is the population: a
fleet of clients whose skew moves together is a real signal, and
[anti-fraud.md](./anti-fraud.md) names it as one.

### Not yet measured

**Queue lag has no Prometheus surface.** It is recorded — every completed job
logs `lagMs`, the time it waited between being **due** and being picked up.
"Due" is `job.timestamp + delay`, not `job.timestamp`: BullMQ creates a
scheduled job the moment the previous one fires and holds it with a delay until
its slot, so measuring from creation reports the cron interval. The first
version did exactly that and read 60,016 ms on a sixty-second cron — a worker
apparently a minute behind, with the real sixteen milliseconds hidden at the
end of the number. But the worker serves no HTTP
and so has no `/metrics` endpoint to scrape. Giving it one is a deployment
change — a port, an Nginx route, a scrape target — and belongs with that work
rather than being half-done here. Until then, queue lag is a log query.
