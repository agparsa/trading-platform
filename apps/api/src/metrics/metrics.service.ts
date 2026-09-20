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
  readonly scheduledJobAge: Gauge<'job'>;
  readonly scheduledJobLate: Gauge<'job'>;
  readonly tenantIsolation: Gauge<'configured'>;
  readonly deadLetterDepth: Gauge<'queue'>;
  readonly deadLetterAge: Gauge<'queue'>;
  /** 1 when this instance leads the loop, 0 when it does not. */
  readonly leaderLease: Gauge<'loop'>;
  readonly leaderTransitions: Counter<'loop' | 'transition'>;

  /**
   * Latency, measured end to end rather than per hop (§34).
   *
   * The number a trader experiences is "the market moved, and how long until my
   * screen said so". Every per-hop timing on the way there can look healthy
   * while that number is four seconds, because the hops are not the whole path
   * — the queueing between them is. So these are all measured from the tick's
   * own timestamp, and the gaps between them say which stage is responsible.
   */
  readonly tickToPnl: Histogram<string>;
  readonly tickToSocket: Histogram<string>;
  readonly quoteAge: Histogram<'symbol' | 'purpose'>;
  readonly orderAck: Histogram<'outcome'>;
  readonly realtimePassLag: Histogram<string>;
  readonly realtimeDeferred: Counter<string>;
  readonly leaseWait: Histogram<'loop'>;
  readonly orderStage: Histogram<'stage'>;
  readonly clientClockSkew: Histogram<string>;

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

    /**
     * Buckets chosen against what a person notices, not against round numbers.
     * Under 100ms is indistinguishable from instant; a second is a visible
     * lag; five seconds is a screen somebody does not trust. Spending
     * resolution below 10ms would measure the process's own scheduler.
     */
    const LATENCY_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

    this.tickToPnl = new Histogram({
      name: 'tp_tick_to_pnl_seconds',
      help: 'From the tick’s own timestamp to the account valuation it produced. The trader-visible number: how long after the market moved the platform knew what it meant.',
      buckets: LATENCY_BUCKETS,
      registers: [this.registry],
    });

    this.tickToSocket = new Histogram({
      name: 'tp_tick_to_socket_seconds',
      help: 'From the tick’s own timestamp to the frames being handed to the sockets. Its gap over tp_tick_to_pnl_seconds is what fan-out costs.',
      buckets: LATENCY_BUCKETS,
      registers: [this.registry],
    });

    this.quoteAge = new Histogram({
      name: 'tp_quote_age_seconds',
      help: 'Age of the price at the moment it was used to decide something, by what it was used for. Not feed health — the age of the number a decision was actually made on.',
      labelNames: ['symbol', 'purpose'] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.orderAck = new Histogram({
      name: 'tp_order_ack_seconds',
      help: 'From an order arriving to the platform answering it, refusals included. A refusal that takes two seconds is still a trader waiting two seconds.',
      labelNames: ['outcome'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.realtimePassLag = new Histogram({
      name: 'tp_realtime_pass_lag_seconds',
      help: 'How much later than intended each realtime valuation pass started. Rising means the pass is taking longer than its own cadence, which is the loop falling behind rather than any one query being slow.',
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.realtimeDeferred = new Counter({
      name: 'tp_realtime_valuations_deferred_total',
      help: 'Account valuations a realtime pass left for the next pass because its time budget (REALTIME_VALUATION_BUDGET_MS) ran out. Rising means screens are refreshing less often than the interval so that orders keep their share of the loop; add a serving instance.',
      registers: [this.registry],
    });

    this.leaseWait = new Histogram({
      name: 'tp_lease_wait_seconds',
      help: 'How long an acquire-or-renew of a leadership lease took. This is the round trip a stalled leader is waiting on, so it is the leading indicator of a lease about to lapse.',
      labelNames: ['loop'] as const,
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.orderStage = new Histogram({
      name: 'tp_order_stage_seconds',
      help: 'Where an order spent its time (§50). tp_order_ack_seconds says a submission took 300ms; this says whether that was the risk valuation, the venue or a row lock — three incidents with three different fixes.',
      labelNames: ['stage'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    this.clientClockSkew = new Histogram({
      name: 'tp_client_clock_skew_seconds',
      help: 'How far behind the server a client believed it was when it sent an order. Recorded, never trusted: a browser clock is whatever the person set it to. A population whose skew moves together is the signal.',
      buckets: [-60, -5, -1, -0.25, 0, 0.25, 1, 5, 60],
      registers: [this.registry],
    });

    this.leaderLease = new Gauge({
      name: 'tp_leader_lease',
      help: 'Whether this instance holds the lease for a singleton loop. Summed across instances it must be 1: 0 means nothing is running the loop, 2 means two are.',
      labelNames: ['loop'] as const,
      registers: [this.registry],
    });

    this.leaderTransitions = new Counter({
      name: 'tp_leader_transitions_total',
      help: 'Leadership changes observed by this instance. A steady rate means the lease is flapping, which is worse than one instance holding it badly.',
      labelNames: ['loop', 'transition'] as const,
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

    /**
     * How long since each scheduled job last *succeeded*, and whether that is
     * longer than its own schedule allows.
     *
     * Two gauges rather than one because they answer different questions. The
     * age is for a graph — a sweep drifting from four minutes to nine is worth
     * seeing before it breaks. `tp_scheduled_job_late` is for an alert, and it
     * is computed here rather than in the alert rule because the threshold
     * depends on the job's own cron: three minutes is catastrophic for the
     * outbox relay and unremarkable for swap accrual, and a Prometheus rule
     * would have to hard-code a number per job and then rot when one changes.
     *
     * `-1` for a job that has never succeeded. A gauge cannot say "never", and
     * zero would read as "just succeeded" — the opposite of the truth, and the
     * reading somebody would fail to page on.
     */
    this.scheduledJobAge = new Gauge({
      name: 'tp_scheduled_job_age_ms',
      help: 'Milliseconds since this scheduled job last succeeded. -1 means it never has, which usually means no worker is registering schedules.',
      labelNames: ['job'] as const,
      registers: [this.registry],
    });

    this.scheduledJobLate = new Gauge({
      name: 'tp_scheduled_job_late',
      help: '1 when this scheduled job is later than its own cron allows, has never run, is failing, or is configured with a pattern that cannot be read. Alert on any of it.',
      labelNames: ['job'] as const,
      registers: [this.registry],
    });

    this.tenantIsolation = new Gauge({
      name: 'tp_tenant_isolation',
      help: '1 when row-level security applies to the connection this API uses, 0 when it does not, -1 while there are no rows to prove it either way. The `configured` label is whether DATABASE_URL_TENANT is set: 0 with configured="false" is the documented single-role posture, 0 with configured="true" is a misconfiguration. Without the label the two are one series and the alert docs/observability.md describes could not be written.',
      labelNames: ['configured'] as const,
      registers: [this.registry],
    });

    this.deadLetterDepth = new Gauge({
      name: 'tp_dead_letter_depth',
      help: 'Jobs sitting in this queue\u2019s failed set. Queues keep failures (removeOnFail: false) so a financial job that gave up stays visible until a human has looked at it; anything above zero means one is waiting. Alert on it.',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });

    this.deadLetterAge = new Gauge({
      name: 'tp_dead_letter_newest_age_ms',
      help: 'Milliseconds since the most recent job in this queue gave up. -1 when the failed set is empty. Depth says how many are waiting; this says whether anything is still going wrong — the two answer different questions and an alert that conflates them pages about resolved incidents for ever.',
      labelNames: ['queue'] as const,
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
