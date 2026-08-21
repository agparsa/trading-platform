import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Prometheus registry.
 *
 * The metrics declared here are the ones docs/observability.md commits to;
 * later phases increment them rather than inventing new names ad hoc, so the
 * dashboards keep working.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly marketTicks: Counter<'symbol'>;
  readonly ordersSubmitted: Counter<'symbol' | 'type' | 'outcome'>;
  readonly executionLatency: Histogram<'symbol'>;
  readonly websocketConnections: Counter<'event'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'tp_' });

    this.httpRequests = new Counter({
      name: 'tp_http_requests_total',
      help: 'HTTP requests handled, by route and status.',
      labelNames: ['method', 'route', 'status'] as const,
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: 'tp_http_request_duration_seconds',
      help: 'HTTP request duration.',
      labelNames: ['method', 'route'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    this.marketTicks = new Counter({
      name: 'tp_market_ticks_total',
      help: 'Market ticks ingested, by symbol.',
      labelNames: ['symbol'] as const,
      registers: [this.registry],
    });

    this.ordersSubmitted = new Counter({
      name: 'tp_orders_submitted_total',
      help: 'Orders submitted, by symbol, type and outcome.',
      labelNames: ['symbol', 'type', 'outcome'] as const,
      registers: [this.registry],
    });

    this.executionLatency = new Histogram({
      name: 'tp_execution_latency_seconds',
      help: 'Time from order acceptance to fill.',
      labelNames: ['symbol'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry],
    });

    this.websocketConnections = new Counter({
      name: 'tp_websocket_events_total',
      help: 'WebSocket connection lifecycle events.',
      labelNames: ['event'] as const,
      registers: [this.registry],
    });
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
