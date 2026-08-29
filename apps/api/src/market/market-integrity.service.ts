import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TickGate, TickRejection, type Tick, type TickVerdict } from '@tp/market-core';
import { MetricsService } from '../metrics/metrics.service';
import type { Env } from '../config/env.schema';

/**
 * The one door market data comes through.
 *
 * `TickGate` in `@tp/market-core` holds the judgement, which is pure and
 * framework-free and tested there. This holds what an operator needs when it
 * fires: a counter per symbol per reason, a log line that says what was refused
 * and why, and a summary the health endpoint can read.
 *
 * ## What a rejection is, and is not
 *
 * It is a statement about the **feed**, never about the market and never about
 * a trader. Nothing here closes a position, breaches an account or fails an
 * order — §26's rule that an API fault must not be read as a rule violation
 * applies with equal force to a fault in the price stream. The worst a rejection
 * does is leave the previous price standing, and `QuoteService.requireFresh`
 * already refuses to trade on a price that has stopped moving.
 *
 * ## Why the log is rate-limited and the counter is not
 *
 * A feed that has genuinely broken produces four bad ticks a second per
 * instrument. Logging each one buries the incident in its own noise and can fill
 * a disk faster than anybody reads the first line. The counter is exact; the log
 * carries the first of each run and then falls silent until the run ends.
 */
@Injectable()
export class MarketIntegrityService {
  private readonly logger = new Logger(MarketIntegrityService.name);
  private readonly gate: TickGate;
  /** Reason currently being suppressed per symbol, so one run logs once. */
  private readonly loggedRun = new Map<string, TickRejection>();
  private readonly rejectionTotals = new Map<string, number>();

  constructor(
    @Inject(ConfigService) config: ConfigService<Env, true>,
    private readonly metrics: MetricsService,
  ) {
    this.gate = new TickGate({
      maxSpreadRatio: config.getOrThrow('MARKET_MAX_SPREAD_RATIO', { infer: true }),
      maxJumpRatio: config.getOrThrow('MARKET_MAX_JUMP_RATIO', { infer: true }),
      maxFutureSkewMs: config.getOrThrow('MARKET_MAX_FUTURE_SKEW_MS', { infer: true }),
      reanchorAfter: config.getOrThrow('MARKET_REANCHOR_AFTER', { infer: true }),
    });
  }

  /**
   * Judge a tick. `true` means it may become a price.
   *
   * The verdict is returned rather than thrown: a bad tick is an expected event
   * on a real feed, and an exception on the ingest path would take the whole
   * pass down with it.
   */
  admit(tick: Tick, nowMs: number = Date.now()): TickVerdict {
    const verdict = this.gate.admit(tick, nowMs);

    if (verdict.accepted && verdict.reason === null) {
      this.loggedRun.delete(tick.symbol);
      return verdict;
    }

    const reason = verdict.reason ?? TickRejection.MALFORMED;

    if (verdict.reanchored) {
      // Loud, always, and never suppressed. The platform has just followed a
      // move it spent several ticks refusing; somebody should see that.
      this.metrics.ticksReanchored.inc({ symbol: tick.symbol, reason });
      this.loggedRun.delete(tick.symbol);
      this.logger.warn(
        { symbol: tick.symbol, reason, detail: verdict.detail, bid: tick.bid, ask: tick.ask },
        'Market data gate re-anchored after a run of rejections; the platform is now following this price',
      );
      return verdict;
    }

    this.metrics.ticksRejected.inc({ symbol: tick.symbol, reason });
    this.rejectionTotals.set(tick.symbol, (this.rejectionTotals.get(tick.symbol) ?? 0) + 1);

    if (this.loggedRun.get(tick.symbol) !== reason) {
      this.loggedRun.set(tick.symbol, reason);
      this.logger.error(
        { symbol: tick.symbol, reason, detail: verdict.detail, bid: tick.bid, ask: tick.ask },
        'Market data rejected; the previous price stands',
      );
    }

    return verdict;
  }

  /** What the health endpoint reports. */
  summary(): {
    symbols: number;
    rejectedTotal: number;
    symbolsInRejectionRun: string[];
  } {
    let rejectedTotal = 0;
    for (const count of this.rejectionTotals.values()) rejectedTotal += count;

    const inRun: string[] = [];
    for (const symbol of this.rejectionTotals.keys()) {
      if (this.gate.rejectionRun(symbol) > 0) inRun.push(symbol);
    }

    return { symbols: this.gate.size, rejectedTotal, symbolsInRejectionRun: inRun.sort() };
  }

  /** The last tick that got through for a symbol. */
  lastAccepted(symbol: string): Tick | null {
    return this.gate.last(symbol);
  }
}
