import { BrokerErrorCode, ConnectionState, type AdapterHealth } from './types';

/**
 * The connection state machine, the backoff and the circuit breaker, as one
 * object with no I/O in it.
 *
 * The monitor is told what happened — a health check came back, a call
 * failed, a quote arrived — and decides what the state is and whether the
 * next attempt may go now. The worker owns the clock and the adapter; this
 * owns the judgement, so the judgement can be tested to the millisecond
 * without a venue.
 *
 * ## The rules
 *
 * - A failure is counted; a success clears the count. Both are stamped.
 * - After `openAfterFailures` consecutive failures the breaker **opens** for
 *   `min(base × 2^n, cap)`, doubling per opening and reset by a success. While
 *   open, `mayAttempt` is false — the venue is not hammered, and the platform
 *   refuses external orders on this connection rather than queueing them.
 * - AUTH_FAILED opens the breaker at once and for the cap: retrying the same
 *   credentials cannot help and can lock the account at the venue.
 * - RATE_LIMITED opens the breaker for the venue's `retryAfterMs` when it
 *   gave one, else the current backoff.
 * - CONNECTED becomes DEGRADED when the last quote or the last heartbeat is
 *   older than the connection's expectation. Degraded is not failed: orders
 *   still go, with the state shown, because a quiet venue at 03:00 on Sunday
 *   is not an outage.
 * - Nothing here says an account breached a rule. A timeout is a timeout.
 */
export interface MonitorOptions {
  /** Consecutive failures before the breaker opens. */
  readonly openAfterFailures: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
  /** How stale a heartbeat may be before CONNECTED becomes DEGRADED. */
  readonly heartbeatStaleMs: number;
  /** How stale the last quote may be before DEGRADED; null to ignore quotes. */
  readonly quoteStaleMs: number | null;
}

export const DEFAULT_MONITOR_OPTIONS: MonitorOptions = Object.freeze({
  openAfterFailures: 3,
  backoffBaseMs: 5_000,
  backoffCapMs: 5 * 60_000,
  heartbeatStaleMs: 45_000,
  quoteStaleMs: 120_000,
});

export interface MonitorSnapshot {
  readonly state: ConnectionState;
  readonly consecutiveFailures: number;
  readonly openings: number;
  readonly circuitOpenUntil: Date | null;
  readonly lastHeartbeatAt: Date | null;
  readonly lastQuoteAt: Date | null;
  readonly lastOrderEventAt: Date | null;
  readonly lastError: string | null;
  readonly latencyMs: number | null;
}

export interface Transition {
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  readonly reason: string;
  readonly at: Date;
}

export class ConnectionMonitor {
  private state: ConnectionState = ConnectionState.UNKNOWN;
  private consecutiveFailures = 0;
  private openings = 0;
  private circuitOpenUntil: Date | null = null;
  private lastHeartbeatAt: Date | null = null;
  private lastQuoteAt: Date | null = null;
  private lastOrderEventAt: Date | null = null;
  private lastError: string | null = null;
  private latencyMs: number | null = null;
  private readonly transitions: Transition[] = [];

  constructor(private readonly options: MonitorOptions = DEFAULT_MONITOR_OPTIONS) {}

  /** Restore from what the database holds, after a restart. UNKNOWN until something is heard. */
  static restore(
    saved: Partial<MonitorSnapshot>,
    options: MonitorOptions = DEFAULT_MONITOR_OPTIONS,
  ): ConnectionMonitor {
    const monitor = new ConnectionMonitor(options);
    monitor.consecutiveFailures = saved.consecutiveFailures ?? 0;
    monitor.openings = saved.openings ?? 0;
    monitor.circuitOpenUntil = saved.circuitOpenUntil ?? null;
    monitor.lastHeartbeatAt = saved.lastHeartbeatAt ?? null;
    monitor.lastQuoteAt = saved.lastQuoteAt ?? null;
    monitor.lastOrderEventAt = saved.lastOrderEventAt ?? null;
    monitor.lastError = saved.lastError ?? null;
    return monitor;
  }

  snapshot(): MonitorSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openings: this.openings,
      circuitOpenUntil: this.circuitOpenUntil,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastQuoteAt: this.lastQuoteAt,
      lastOrderEventAt: this.lastOrderEventAt,
      lastError: this.lastError,
      latencyMs: this.latencyMs,
    };
  }

  /** Every state change so far, oldest first. What the panel's timeline shows. */
  history(): readonly Transition[] {
    return this.transitions;
  }

  /** May the worker attempt a connect or a health check now? */
  mayAttempt(now: Date): boolean {
    return this.circuitOpenUntil === null || this.circuitOpenUntil.getTime() <= now.getTime();
  }

  /** May the platform route an order over this connection now? */
  mayTrade(now: Date): boolean {
    return (
      this.mayAttempt(now) &&
      (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.DEGRADED)
    );
  }

  connecting(now: Date): void {
    this.move(ConnectionState.CONNECTING, 'connecting', now);
  }

  /** A health check answered. The adapter's own view of its state is the input, not the verdict. */
  healthReported(health: AdapterHealth, now: Date): void {
    this.latencyMs = health.latencyMs;
    if (health.lastQuoteAt !== null) this.lastQuoteAt = later(this.lastQuoteAt, health.lastQuoteAt);
    if (health.lastOrderEventAt !== null) {
      this.lastOrderEventAt = later(this.lastOrderEventAt, health.lastOrderEventAt);
    }

    switch (health.state) {
      case ConnectionState.CONNECTED:
      case ConnectionState.DEGRADED:
        this.lastHeartbeatAt = now;
        this.succeeded(now);
        this.move(this.freshness(now), health.detail ?? 'healthy', now);
        return;
      case ConnectionState.AUTH_FAILED:
        this.failed(BrokerErrorCode.AUTH_FAILED, health.detail ?? 'authentication failed', now);
        return;
      case ConnectionState.RATE_LIMITED:
        this.failed(BrokerErrorCode.RATE_LIMITED, health.detail ?? 'rate limited', now);
        return;
      case ConnectionState.DISCONNECTED:
      case ConnectionState.CONNECTING:
      case ConnectionState.UNKNOWN:
        this.failed(BrokerErrorCode.NOT_CONNECTED, health.detail ?? 'not connected', now);
        return;
    }
  }

  /** A quote arrived. Freshens DEGRADED back to CONNECTED without a health check. */
  quoteSeen(at: Date): void {
    this.lastQuoteAt = later(this.lastQuoteAt, at);
    if (this.state === ConnectionState.DEGRADED) this.move(this.freshness(at), 'quote', at);
  }

  orderEventSeen(at: Date): void {
    this.lastOrderEventAt = later(this.lastOrderEventAt, at);
  }

  /** A call failed. `retryAfterMs` is the venue's own instruction when it gave one. */
  failed(code: string, detail: string, now: Date, retryAfterMs: number | null = null): void {
    this.consecutiveFailures += 1;
    this.lastError = `${code}: ${detail}`.slice(0, 500);

    if (code === BrokerErrorCode.AUTH_FAILED) {
      this.open(this.options.backoffCapMs, now);
      this.move(ConnectionState.AUTH_FAILED, detail, now);
      return;
    }
    if (code === BrokerErrorCode.RATE_LIMITED) {
      this.open(retryAfterMs ?? this.backoffMs(), now);
      this.move(ConnectionState.RATE_LIMITED, detail, now);
      return;
    }
    if (this.consecutiveFailures >= this.options.openAfterFailures) {
      this.open(this.backoffMs(), now);
    }
    this.move(ConnectionState.DISCONNECTED, detail, now);
  }

  /** Re-evaluate staleness with no new information: the timer tick. */
  tick(now: Date): void {
    if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.DEGRADED) {
      this.move(this.freshness(now), 'tick', now);
    }
  }

  private succeeded(now: Date): void {
    this.consecutiveFailures = 0;
    this.openings = 0;
    this.circuitOpenUntil = null;
    this.lastError = null;
    void now;
  }

  private open(forMs: number, now: Date): void {
    this.openings += 1;
    this.circuitOpenUntil = new Date(now.getTime() + forMs);
  }

  private backoffMs(): number {
    // `openings` counts openings so far; the first opening waits the base.
    const exponent = Math.min(this.openings, 16);
    return Math.min(this.options.backoffBaseMs * 2 ** exponent, this.options.backoffCapMs);
  }

  private freshness(now: Date): ConnectionState {
    const heartbeatStale =
      this.lastHeartbeatAt !== null &&
      now.getTime() - this.lastHeartbeatAt.getTime() > this.options.heartbeatStaleMs;
    const quoteStale =
      this.options.quoteStaleMs !== null &&
      this.lastQuoteAt !== null &&
      now.getTime() - this.lastQuoteAt.getTime() > this.options.quoteStaleMs;
    return heartbeatStale || quoteStale ? ConnectionState.DEGRADED : ConnectionState.CONNECTED;
  }

  private move(to: ConnectionState, reason: string, at: Date): void {
    if (to === this.state) return;
    this.transitions.push({ from: this.state, to, reason, at });
    if (this.transitions.length > 200) this.transitions.shift();
    this.state = to;
  }
}

function later(a: Date | null, b: Date): Date {
  return a === null || b.getTime() > a.getTime() ? b : a;
}
