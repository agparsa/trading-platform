import type { NextFunction, Request, Response } from 'express';
import type { MetricsService } from '../metrics/metrics.service';

/**
 * The two HTTP metrics, which were declared and never fed.
 *
 * `tp_http_requests_total` and `tp_http_request_duration_seconds` were
 * registered in `MetricsService` from the beginning, printed in
 * `observability.md`'s table of what this platform exports, plotted on two
 * panels of the shipped Grafana dashboard, and used by the `RequestsShed` alert
 * in `alerts.yml`. **Nothing ever incremented either of them.** Six requests
 * through a running instance produced a `# HELP` line and zero samples.
 *
 * A metric registered with no samples is worse than a missing one: Prometheus
 * answers a query against it with *no data* rather than an error, a panel draws
 * an empty chart rather than a broken one, and an alert on a series that never
 * exists never fires and never says why.
 *
 * ## Why Express middleware and not a Nest interceptor
 *
 * The `RequestsShed` alert counts 503s from admission control, and admission
 * control is `DrainState.middleware()` — mounted on Express *before* Nest, and
 * it answers a shed request itself without calling `next()`. A Nest interceptor
 * never sees those, which is to say it would miss the exact responses the alert
 * exists to count. This is mounted ahead of the drain for the same reason.
 */
export function httpMetrics(metrics: MetricsService) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const labels = { method: request.method, route: routeLabel(request) };
      metrics.httpRequests.inc({ ...labels, status: String(response.statusCode) });
      metrics.httpDuration.observe(labels, seconds);
    });
    next();
  };
}

/**
 * Anything that looks like an identifier rather than a path segment.
 *
 * A uuid, a long opaque id, or a bare number — the shapes this platform's own
 * routes carry: account ids, order ids, ticket numbers.
 */
const IDENTIFIER =
  /\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[A-Za-z0-9_-]{24,})(?=\/|$)/i;

/** What a request is labelled as when no route matched, or the label is unsafe. */
export const UNMATCHED = 'unmatched';

/**
 * The **route pattern**, never the URL.
 *
 * This is the whole reason this file is longer than four lines. A label value
 * is a distinct time series, and `/api/v1/accounts/<uuid>/positions` as a label
 * would mean one series per account for ever — which kills the metrics store,
 * and puts account identifiers into a system with its own access rules and its
 * own retention. Express fills `req.route` once a route has matched, and by the
 * time `finish` fires it is there.
 *
 * The identifier check is deliberate belt and braces rather than defensive
 * clutter: if a future Express or a hand-mounted handler ever leaves the raw
 * path here, the failure would be silent, expensive, and a privacy incident. A
 * label that still looks like an id is dropped to `unmatched`.
 */
export function routeLabel(request: {
  readonly baseUrl?: string;
  readonly route?: { path?: unknown } | undefined;
  readonly originalUrl?: string;
}): string {
  const pattern = request.route?.path;
  if (typeof pattern !== 'string' || pattern.length === 0) return UNMATCHED;
  const full = `${request.baseUrl ?? ''}${pattern}` || pattern;
  return IDENTIFIER.test(full) ? UNMATCHED : full;
}
