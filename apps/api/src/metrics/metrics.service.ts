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
  readonly ticksCoalesced: Counter<'symbol'>;
  readonly ticksRejected: Counter<'symbol' | 'reason'>;
  readonly ticksReanchored: Counter<'symbol' | 'reason'>;

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

    this.ticksCoalesced = new Counter({
      name: 'tp_ticks_coalesced_total',
      help: 'Ticks folded into a running trigger pass rather than starting their own. A rising rate means the engine is behind the feed.',
      labelNames: ['symbol'],
      registers: [this.registry],
    });

    this.ticksRejected = new Counter({
      name: 'tp_market_ticks_rejected_total',
      help: 'Ticks refused by the integrity gate, by symbol and reason. A rising CROSSED or OUT_OF_ORDER rate is a broken feed, not a market.',
      labelNames: ['symbol', 'reason'] as const,
      registers: [this.registry],
    });

    this.ticksReanchored = new Counter({
      name: 'tp_market_ticks_reanchored_total',
      help: 'Ticks accepted only because the integrity gate re-anchored after a run of rejections. Each one means the platform followed a move it first refused.',
      labelNames: ['symbol', 'reason'] as const,
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
