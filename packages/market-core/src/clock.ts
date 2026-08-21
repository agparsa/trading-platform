/**
 * Time as an injected dependency.
 *
 * Nothing in the platform calls `Date.now()` directly. A test that cannot
 * control the clock cannot deterministically test a daily reset, a swap
 * accrual, a session boundary or an order expiry — and those are exactly the
 * places where a subtle bug costs real money.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch, UTC. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Manually advanced clock for tests and deterministic replays. */
export class ManualClock implements Clock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (ms < 0) throw new RangeError('ManualClock cannot move backwards');
    this.current += ms;
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
