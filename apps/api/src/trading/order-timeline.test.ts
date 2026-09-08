import { describe, expect, it } from 'vitest';
import { clientSkewMs, OrderTimeline } from './order-timeline';

describe('order timeline', () => {
  it('measures each stage from the end of the one before it', () => {
    const timeline = new OrderTimeline(1_000);
    timeline.mark('received', 1_002);
    timeline.mark('validated', 1_020);
    timeline.mark('priced', 1_035);

    expect(timeline.spans()).toEqual([
      { stage: 'received', ms: 2 },
      { stage: 'validated', ms: 18 },
      { stage: 'priced', ms: 15 },
    ]);
  });

  /**
   * The point of the breakdown. An end-to-end number says an order took 35ms;
   * only the spans say that 18 of them were the risk valuation.
   */
  it('sums to the total', () => {
    const timeline = new OrderTimeline(1_000);
    timeline.mark('received', 1_002);
    timeline.mark('validated', 1_020);
    timeline.mark('executed', 1_035);

    const total = timeline.spans().reduce((sum, span) => sum + span.ms, 0);
    expect(total).toBe(timeline.totalMs());
    expect(total).toBe(35);
  });

  /**
   * A path that refuses an order early marks two stages and stops. Reporting
   * the unmarked ones as zero would put a spike of zeros into every percentile
   * and quietly move the median of the stages that did run.
   */
  it('leaves unmarked stages out rather than reporting them as zero', () => {
    const timeline = new OrderTimeline(1_000);
    timeline.mark('received', 1_001);

    expect(timeline.spans().map((span) => span.stage)).toEqual(['received']);
    expect(timeline.toLog()).toEqual({ received: 1 });
  });

  /** A clock that steps backwards must not produce a negative duration. */
  it('never reports a negative span', () => {
    const timeline = new OrderTimeline(1_000);
    timeline.mark('received', 900);
    expect(timeline.spans()).toEqual([{ stage: 'received', ms: 0 }]);
    expect(timeline.totalMs()).toBe(0);
  });

  describe('client skew', () => {
    it('is the gap between what the client said and when it arrived', () => {
      expect(clientSkewMs(1_000, 1_250)).toBe(250);
    });

    /**
     * Negative when the client's clock is ahead of the server's. Kept as a
     * signed number rather than clamped: "every client is suddenly 40 seconds
     * ahead" is the observation worth having, and clamping would hide it.
     */
    it('is negative when the client is ahead', () => {
      expect(clientSkewMs(2_000, 1_000)).toBe(-1_000);
    });

    it('is null when the client said nothing', () => {
      expect(clientSkewMs(null, 1_000)).toBeNull();
      expect(clientSkewMs(Number.NaN, 1_000)).toBeNull();
    });
  });
});
