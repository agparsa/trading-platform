import { toDecimal } from '@tp/financial-core';
import type { Tick } from './types';

/**
 * The gate every tick passes before it becomes a price.
 *
 * ## Why this exists
 *
 * Until now a tick became the platform's price by arriving. Whatever the feed
 * said was what positions were marked at, what stops were evaluated against, and
 * what margin was computed from. `isBookSane` was written and never called.
 *
 * A market data feed is the one input this system does not control, and every
 * fault it can have is a fault that reaches money:
 *
 *  - a **crossed book** (ask below bid) makes every spread negative and every
 *    fill nonsense;
 *  - an **out-of-order tick** — perfectly normal over an unordered transport —
 *    replaces a current price with an older one, and the older one then decides
 *    whether a stop fires;
 *  - a **spike**, a decimal point in the wrong place, fires every stop below it
 *    and every target above it in one pass, and those closes are real;
 *  - a **future timestamp** passes every freshness check for as long as the
 *    clock skew lasts, so a dead feed looks alive.
 *
 * None of these is exotic. All of them have happened to real venues.
 *
 * ## The rule that shapes the design
 *
 * A rejected tick is a *feed* problem and must never be read as a market event.
 * Nothing here closes a position, breaches an account or fails an order. The
 * worst a rejection does is leave the previous price standing, which the
 * existing staleness rules already handle: `requireFresh` refuses to trade on a
 * price that has stopped moving, and that refusal is the safe direction.
 *
 * ## Why a gate that never re-opens would be worse than no gate
 *
 * A guard that rejects everything after one bad tick freezes the price forever.
 * The engine would then mark positions, compute margin and evaluate stops
 * against an anchor that stopped moving — silently, and with every appearance of
 * working. So the two *plausibility* rejections (spike, spread) re-anchor after
 * a run of consecutive rejections: the market really can gap 10% and really can
 * open with a spread five times normal, and when it does, the platform must
 * follow it rather than pretend it did not happen.
 *
 * The two *impossibility* rejections never re-anchor. A crossed book and a
 * negative price are not market conditions; they are broken data, and accepting
 * them after enough repetitions would only mean corrupting prices more slowly.
 */

export const TickRejection = {
  /** bid or ask is not a parseable decimal. */
  MALFORMED: 'MALFORMED',
  /** bid or ask is zero or negative. Never a market condition. */
  NON_POSITIVE: 'NON_POSITIVE',
  /** ask is not above bid. Never a market condition. */
  CROSSED: 'CROSSED',
  /** Older than the tick already accepted for this symbol. */
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  /** Timestamped beyond the tolerated clock skew into the future. */
  FUTURE: 'FUTURE',
  /** Spread is implausibly wide relative to the price. */
  SPREAD: 'SPREAD',
  /** Mid moved further in one tick than the configured limit. */
  SPIKE: 'SPIKE',
} as const;
export type TickRejection = (typeof TickRejection)[keyof typeof TickRejection];

/** Rejections that describe impossible data rather than an extreme market. */
const NEVER_REANCHOR: ReadonlySet<TickRejection> = new Set([
  TickRejection.MALFORMED,
  TickRejection.NON_POSITIVE,
  TickRejection.CROSSED,
  TickRejection.OUT_OF_ORDER,
  TickRejection.FUTURE,
]);

export interface TickGateConfig {
  /**
   * Largest tolerated spread as a fraction of the mid. `null` disables the
   * check. 0.05 means a spread wider than 5% of the price is refused.
   */
  readonly maxSpreadRatio: number | null;
  /**
   * Largest tolerated move of the mid between consecutive accepted ticks, as a
   * fraction of the previous mid. `null` disables the check.
   */
  readonly maxJumpRatio: number | null;
  /** How far into the future a tick may be timestamped before it is refused. */
  readonly maxFutureSkewMs: number;
  /**
   * Consecutive plausibility rejections after which the gate accepts the next
   * tick and re-anchors on it. Must be at least 1.
   */
  readonly reanchorAfter: number;
}

export const DEFAULT_TICK_GATE: TickGateConfig = {
  // Generous. This is a broken-feed detector, not a liquidity opinion: a real
  // spread of 5% of the price does not happen on anything this platform lists.
  maxSpreadRatio: 0.05,
  // A 10% move between two ticks is a decimal point, not a market — except at
  // an illiquid open, which is why it re-anchors.
  maxJumpRatio: 0.1,
  maxFutureSkewMs: 5_000,
  reanchorAfter: 5,
};

export interface TickVerdict {
  readonly accepted: boolean;
  readonly reason: TickRejection | null;
  /** Human-readable detail, for the log line and the metric label. */
  readonly detail: string | null;
  /** True when the tick was accepted only because the gate re-anchored. */
  readonly reanchored: boolean;
}

const ACCEPTED: TickVerdict = { accepted: true, reason: null, detail: null, reanchored: false };

/**
 * Judges one tick against the previous accepted tick for its symbol.
 *
 * Pure: no clock, no state, no logging. `nowMs` is passed in so the future-skew
 * check is testable, and `previous` is passed in so the caller owns the memory.
 */
export function inspectTick(
  tick: Tick,
  previous: Tick | null,
  config: TickGateConfig,
  nowMs: number,
): TickVerdict {
  if (!isDecimalString(tick.bid) || !isDecimalString(tick.ask)) {
    return reject(TickRejection.MALFORMED, `bid=${tick.bid} ask=${tick.ask}`);
  }

  const bid = toDecimal(tick.bid);
  const ask = toDecimal(tick.ask);

  if (bid.lte(0) || ask.lte(0)) {
    return reject(TickRejection.NON_POSITIVE, `bid=${tick.bid} ask=${tick.ask}`);
  }
  if (ask.lte(bid)) {
    return reject(TickRejection.CROSSED, `bid=${tick.bid} ask=${tick.ask}`);
  }
  if (!Number.isFinite(tick.timestamp)) {
    return reject(TickRejection.MALFORMED, `timestamp=${String(tick.timestamp)}`);
  }
  if (tick.timestamp > nowMs + config.maxFutureSkewMs) {
    return reject(TickRejection.FUTURE, `${tick.timestamp - nowMs}ms ahead`);
  }

  // An equal timestamp is accepted: two ticks within one millisecond is normal
  // at any real rate, and the later arrival is at least as current.
  if (previous !== null && tick.timestamp < previous.timestamp) {
    return reject(TickRejection.OUT_OF_ORDER, `${previous.timestamp - tick.timestamp}ms behind`);
  }

  const mid = bid.plus(ask).div(2);

  if (config.maxSpreadRatio !== null) {
    const ratio = ask.minus(bid).div(mid);
    if (ratio.gt(config.maxSpreadRatio)) {
      return reject(TickRejection.SPREAD, `spread is ${ratio.times(100).toFixed(2)}% of mid`);
    }
  }

  if (config.maxJumpRatio !== null && previous !== null) {
    const previousMid = toDecimal(previous.bid).plus(toDecimal(previous.ask)).div(2);
    if (previousMid.gt(0)) {
      const move = mid.minus(previousMid).abs().div(previousMid);
      if (move.gt(config.maxJumpRatio)) {
        return reject(TickRejection.SPIKE, `mid moved ${move.times(100).toFixed(2)}%`);
      }
    }
  }

  return ACCEPTED;
}

function reject(reason: TickRejection, detail: string): TickVerdict {
  return { accepted: false, reason, detail, reanchored: false };
}

function isDecimalString(value: string): boolean {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) && value.trim() !== '';
}

/**
 * The gate, with the per-symbol memory `inspectTick` deliberately does not hold.
 *
 * Framework-free on purpose: the API wraps it to add metrics and logging, and
 * the worker could use the same instance for a different feed. Nothing here
 * knows what a position is.
 */
export class TickGate {
  private readonly lastAccepted = new Map<string, Tick>();
  private readonly consecutiveRejections = new Map<string, number>();
  private readonly config: TickGateConfig;

  constructor(config: Partial<TickGateConfig> = {}) {
    const merged = { ...DEFAULT_TICK_GATE, ...config };
    this.config = { ...merged, reanchorAfter: Math.max(1, Math.trunc(merged.reanchorAfter)) };
  }

  /**
   * Judge a tick, remembering it if it is accepted.
   *
   * The caller decides what to do with a rejection. It must not treat one as a
   * market event of any kind.
   */
  admit(tick: Tick, nowMs: number = Date.now()): TickVerdict {
    const previous = this.lastAccepted.get(tick.symbol) ?? null;
    const verdict = inspectTick(tick, previous, this.config, nowMs);

    if (verdict.accepted) {
      this.accept(tick);
      return verdict;
    }

    const run = (this.consecutiveRejections.get(tick.symbol) ?? 0) + 1;

    // Impossible data never earns its way in, however often it repeats.
    if (verdict.reason !== null && NEVER_REANCHOR.has(verdict.reason)) {
      this.consecutiveRejections.set(tick.symbol, run);
      return verdict;
    }

    if (run >= this.config.reanchorAfter) {
      // The market really has moved, or really is that wide. Following it is
      // the safe direction; refusing forever would leave the engine marking
      // positions against a price that stopped moving.
      this.accept(tick);
      return { ...verdict, accepted: true, reanchored: true };
    }

    this.consecutiveRejections.set(tick.symbol, run);
    return verdict;
  }

  /** The last tick this gate let through for a symbol. */
  last(symbol: string): Tick | null {
    return this.lastAccepted.get(symbol) ?? null;
  }

  /** How many ticks in a row have been refused for a symbol. */
  rejectionRun(symbol: string): number {
    return this.consecutiveRejections.get(symbol) ?? 0;
  }

  /** Drops a symbol's memory — for a delisting, or a deliberate re-anchor. */
  forget(symbol: string): void {
    this.lastAccepted.delete(symbol);
    this.consecutiveRejections.delete(symbol);
  }

  get size(): number {
    return this.lastAccepted.size;
  }

  private accept(tick: Tick): void {
    this.lastAccepted.set(tick.symbol, tick);
    this.consecutiveRejections.delete(tick.symbol);
  }
}

/**
 * A book is sane when both sides are positive and the ask is above the bid.
 *
 * Kept as its own export because the health indicator asks exactly this
 * question about the last known quote, which is a different question from
 * "should this tick be admitted".
 */
export function isBookSane(tick: Tick): boolean {
  if (!isDecimalString(tick.bid) || !isDecimalString(tick.ask)) return false;
  return toDecimal(tick.bid).gt(0) && toDecimal(tick.ask).gt(toDecimal(tick.bid));
}
