import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

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

  /**
   * Gauges: the platform's shape right now, rather than what has happened.
   *
   * A counter answers "how many orders since this process started"; none of
   * these can be derived from one. "How many accounts are frozen" and "how many
   * positions is the engine checking against every tick" are the questions asked
   * during an incident, and both are states, not events.
   *
   * Set by `PlatformMetricsService` on a schedule — deliberately not on every
   * request, which would put a `COUNT(*)` in the trading path to keep a
   * dashboard current.
   */
  readonly accounts: Gauge<'status'>;
  readonly openPositions: Gauge<string>;
  readonly connectedSockets: Gauge<'state'>;
  readonly openFindings: Gauge<'severity'>;
  readonly openSignals: Gauge<'severity'>;
  readonly marketFeedAge: Gauge<string>;

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

    this.accounts = new Gauge({
      name: 'tp_accounts',
      help: 'Accounts by status. A rising SUSPENDED or CLOSE_ONLY count is an operational event.',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.openPositions = new Gauge({
      name: 'tp_open_positions',
      help: 'Positions the trigger engine checks against every tick. Per-tick cost scales with this, not with how busy any one trader is.',
      registers: [this.registry],
    });

    this.connectedSockets = new Gauge({
      name: 'tp_connected_sockets',
      help: 'WebSocket connections held open on this instance, authenticated or not.',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });

    this.openFindings = new Gauge({
      name: 'tp_reconciliation_findings_open',
      help: 'Reconciliation discrepancies nobody has closed, by severity. A CRITICAL above zero means records disagree about money.',
      labelNames: ['severity'] as const,
      registers: [this.registry],
    });

    this.openSignals = new Gauge({
      name: 'tp_integrity_signals_open',
      help: 'Integrity observations awaiting review, by severity.',
      labelNames: ['severity'] as const,
      registers: [this.registry],
    });

    this.marketFeedAge = new Gauge({
      name: 'tp_market_feed_age_ms',
      help: 'Age of the newest tick this instance holds. Rising means the feed, or this process, is behind — and the engine will start refusing orders with STALE_QUOTE.',
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
