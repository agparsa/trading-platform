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

`tp_execution_latency_seconds` measures acceptance → fill. It is the number that
tells you whether the engine is healthy under load, and the one that will
regress first.

## Health

`/health` — liveness, no dependencies touched.
`/ready` — readiness, reports database and Redis status with measured latencies.

Health indicators report `error.name` rather than `error.message`, because
driver messages contain connection strings.

## What to alert on

| Signal                                    | Why                                                              |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Readiness failing                         | The instance cannot trade                                        |
| `tp_execution_latency_seconds` p99 rising | The engine is falling behind the market                          |
| `tp_market_ticks_total` flat              | The feed died; quotes are going stale                            |
| Ledger vs `accounts.balance` drift        | Reconciliation found a discrepancy — the most serious alert here |
| Dead-letter depth > 0                     | A financial job failed and is waiting for a human                |

Failed jobs are retained deliberately (`removeOnFail: false`): a failed financial
job must stay visible until someone has looked at it.
