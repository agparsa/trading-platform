import { describe, expect, it } from 'vitest';
import {
  detectAll,
  detectConcentration,
  detectDuplicateOrders,
  detectOrderBurst,
  detectRapidCancelReplace,
  detectRapidOpenClose,
  detectRepeatedRejections,
  detectVolumeSpike,
} from './detectors';
import {
  DEFAULT_THRESHOLDS,
  SignalCode,
  SignalSeverity,
  type ActivityWindow,
  type OrderChurnObservation,
  type OrderObservation,
} from './types';

/**
 * Every detector is tested twice: once with the pattern, once with ordinary
 * trading that superficially resembles it.
 *
 * The second half is the important half. A detector that fires on normal
 * behaviour is worse than no detector — it produces a queue nobody reads, and by
 * the time something real arrives the operators have been trained for weeks to
 * dismiss it. So each of these has a "and this is just a busy trader" case
 * sitting immediately beneath it, built to be as close to the threshold as
 * normal activity plausibly gets.
 */

const NOW = 1_800_000_000_000;

function order(overrides: Partial<OrderObservation> = {}): OrderObservation {
  return {
    id: `o-${Math.random().toString(36).slice(2, 8)}`,
    createdAtMs: NOW - 1_000,
    status: 'FILLED',
    symbol: 'XAUUSD',
    side: 'BUY',
    volume: '1',
    price: null,
    ...overrides,
  };
}

function window(overrides: Partial<ActivityWindow> = {}): ActivityWindow {
  return {
    accountId: 'acct-1',
    nowMs: NOW,
    orders: [],
    closedPositions: [],
    exposure: [],
    ...overrides,
  };
}

/** `count` orders spread evenly across `spanMs`, ending now. */
function burst(count: number, spanMs: number, overrides: Partial<OrderObservation> = {}) {
  const step = count > 1 ? spanMs / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) =>
    order({ createdAtMs: NOW - spanMs + i * step, ...overrides }),
  );
}

describe('order burst', () => {
  it('notices orders arriving faster than a person places them', () => {
    const signal = detectOrderBurst(window({ orders: burst(14, 2_000) }));
    expect(signal?.code).toBe(SignalCode.ORDER_BURST);
    expect(signal?.evidence['orders']).toBe(14);
  });

  it('says nothing about a busy trader below the threshold', () => {
    expect(detectOrderBurst(window({ orders: burst(11, 9_000) }))).toBeNull();
  });

  it('says nothing about the same number of orders spread over an hour', () => {
    expect(detectOrderBurst(window({ orders: burst(40, 3_600_000) }))).toBeNull();
  });

  /**
   * A burst that straddles a fixed window's boundary is a burst a fixed window
   * cannot see. The count is taken over the densest slice for exactly this case.
   */
  it('sees a burst that does not line up with the window boundary', () => {
    const orders = burst(14, 2_000).map((o) =>
      order({ ...o, createdAtMs: o.createdAtMs - 30_000 }),
    );
    expect(detectOrderBurst(window({ orders }))?.code).toBe(SignalCode.ORDER_BURST);
  });

  it('escalates severity with the size of the burst, but never past HIGH', () => {
    const moderate = detectOrderBurst(window({ orders: burst(14, 2_000) }));
    const extreme = detectOrderBurst(window({ orders: burst(60, 2_000) }));
    expect(moderate?.severity).toBe(SignalSeverity.MEDIUM);
    expect(extreme?.severity).toBe(SignalSeverity.HIGH);
  });
});

describe('repeated rejections', () => {
  it('notices an order that keeps being refused', () => {
    const orders = burst(6, 30_000, { status: 'REJECTED' });
    const signal = detectRepeatedRejections(window({ orders }));
    expect(signal?.code).toBe(SignalCode.REPEATED_REJECTIONS);
  });

  it('says nothing about a couple of rejections among successful trades', () => {
    const orders = [...burst(20, 50_000), ...burst(2, 5_000, { status: 'REJECTED' })];
    expect(detectRepeatedRejections(window({ orders }))).toBeNull();
  });

  it('says nothing about rejections from an hour ago', () => {
    const orders = burst(10, 5_000, { status: 'REJECTED' }).map((o) =>
      order({ ...o, createdAtMs: o.createdAtMs - 3_600_000 }),
    );
    expect(detectRepeatedRejections(window({ orders }))).toBeNull();
  });

  /**
   * The commonest cause is a broken client, which is a support problem. The
   * severity says so.
   */
  it('is reported at the lowest severity', () => {
    const orders = burst(6, 30_000, { status: 'REJECTED' });
    expect(detectRepeatedRejections(window({ orders }))?.severity).toBe(SignalSeverity.LOW);
  });
});

describe('duplicate orders', () => {
  it('notices the same order sent again and again', () => {
    const orders = burst(4, 2_000, {
      symbol: 'EURUSD',
      side: 'SELL',
      volume: '0.5',
      price: '1.08',
    });
    const signal = detectDuplicateOrders(window({ orders }));
    expect(signal?.code).toBe(SignalCode.DUPLICATE_ORDER_ATTEMPTS);
    expect(signal?.evidence['attempts']).toBe(4);
  });

  /**
   * The negative case that matters most: a trader working a position in equal
   * clips is not a client stuck in a retry loop, and the difference is the
   * spacing.
   */
  it('says nothing about identical clips spread out over minutes', () => {
    const orders = burst(6, 300_000, { volume: '0.5', price: '1.08' });
    expect(detectDuplicateOrders(window({ orders }))).toBeNull();
  });

  it('says nothing when the orders differ in any respect', () => {
    const orders = [
      order({ createdAtMs: NOW - 1_000, volume: '0.5' }),
      order({ createdAtMs: NOW - 900, volume: '0.6' }),
      order({ createdAtMs: NOW - 800, volume: '0.7' }),
      order({ createdAtMs: NOW - 700, side: 'SELL', volume: '0.5' }),
    ];
    expect(detectDuplicateOrders(window({ orders }))).toBeNull();
  });
});

describe('rapid open and close', () => {
  const brief = (count: number, holdMs: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      symbol: 'XAUUSD',
      openedAtMs: NOW - 60_000 - i * 1_000,
      closedAtMs: NOW - 60_000 - i * 1_000 + holdMs,
    }));

  it('notices positions held for a second or two, repeatedly', () => {
    const signal = detectRapidOpenClose(window({ closedPositions: brief(6, 1_500) }));
    expect(signal?.code).toBe(SignalCode.RAPID_OPEN_CLOSE);
  });

  it('says nothing about positions held for minutes', () => {
    expect(detectRapidOpenClose(window({ closedPositions: brief(20, 120_000) }))).toBeNull();
  });

  it('says nothing about one quick trade', () => {
    expect(detectRapidOpenClose(window({ closedPositions: brief(2, 1_000) }))).toBeNull();
  });

  /**
   * This is what scalping looks like from the outside, and scalping is a
   * strategy rather than an offence. The severity has to say so, or the queue
   * fills with legitimate traders.
   */
  it('is reported at the lowest severity, because this is also just scalping', () => {
    expect(detectRapidOpenClose(window({ closedPositions: brief(6, 1_500) }))?.severity).toBe(
      SignalSeverity.LOW,
    );
  });
});

describe('volume spike', () => {
  const routine = burst(10, 600_000, { volume: '1' });

  it("notices an order far above the account's own norm", () => {
    const orders = [...routine, order({ volume: '40' })];
    const signal = detectVolumeSpike(window({ orders }));
    expect(signal?.code).toBe(SignalCode.VOLUME_SPIKE);
    expect(signal?.evidence['median']).toBe('1');
  });

  it('says nothing about an order twice the usual size', () => {
    expect(detectVolumeSpike(window({ orders: [...routine, order({ volume: '2' })] }))).toBeNull();
  });

  /**
   * An account with three orders has no norm. Inventing one would flag its
   * second ever trade for being bigger than its first.
   */
  it('says nothing at all about an account with too little history', () => {
    const orders = [order({ volume: '1' }), order({ volume: '1' }), order({ volume: '50' })];
    expect(detectVolumeSpike(window({ orders }))).toBeNull();
  });

  /**
   * The median, not the mean — one outlier drags a mean towards itself and helps
   * hide the next one. With a mean, this account's norm would be ~4.6 and a 40
   * lot order would look like 8.7×, under the threshold.
   */
  it('is not blinded by an earlier outlier', () => {
    const orders = [...routine, order({ volume: '40' }), order({ volume: '40' })];
    const signal = detectVolumeSpike(window({ orders }));
    expect(signal?.evidence['median']).toBe('1');
    expect(signal?.code).toBe(SignalCode.VOLUME_SPIKE);
  });
});

describe('concentration', () => {
  it('notices almost everything in one instrument', () => {
    const exposure = [
      { symbol: 'XAUUSD', grossNotional: '450000' },
      { symbol: 'EURUSD', grossNotional: '10000' },
    ];
    const signal = detectConcentration(window({ exposure }));
    expect(signal?.code).toBe(SignalCode.CONCENTRATION);
    expect(signal?.evidence['symbol']).toBe('XAUUSD');
  });

  it('says nothing about a spread book', () => {
    const exposure = [
      { symbol: 'XAUUSD', grossNotional: '200000' },
      { symbol: 'EURUSD', grossNotional: '150000' },
      { symbol: 'BTCUSD', grossNotional: '120000' },
    ];
    expect(detectConcentration(window({ exposure }))).toBeNull();
  });

  /**
   * A single position is 100% concentrated by arithmetic and by nothing else,
   * and so is a very small book. Both floors exist so this reports a risk rather
   * than a tautology.
   */
  it('says nothing about a single position', () => {
    const exposure = [{ symbol: 'XAUUSD', grossNotional: '900000' }];
    expect(detectConcentration(window({ exposure }))).toBeNull();
  });

  it('says nothing about a book too small to concentrate', () => {
    const exposure = [
      { symbol: 'XAUUSD', grossNotional: '900' },
      { symbol: 'EURUSD', grossNotional: '10' },
    ];
    expect(detectConcentration(window({ exposure }))).toBeNull();
  });
});

/** `count` amendments on one order, spread evenly across `spanMs`, ending now. */
function churn(
  orderId: string,
  count: number,
  spanMs: number,
  kind: 'MODIFIED' | 'CANCELLED' = 'MODIFIED',
): OrderChurnObservation[] {
  const step = count > 1 ? spanMs / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) => ({
    orderId,
    kind,
    atMs: NOW - spanMs + i * step,
  }));
}

describe('rapid cancel and replace', () => {
  it('notices one order amended over and over', () => {
    const signal = detectRapidCancelReplace(window({ orderChurn: churn('o-1', 10, 30_000) }));
    expect(signal?.code).toBe(SignalCode.RAPID_CANCEL_REPLACE);
    expect(signal?.evidence['orderId']).toBe('o-1');
    expect(signal?.evidence['observed']).toBe(10);
  });

  /**
   * The case that decides whether this detector is usable. Twenty amendments
   * spread over twenty orders is a busy desk; twenty on one order is somebody
   * doing something to that order. Summing them would report every busy morning
   * as an incident until operators learned to ignore the code.
   */
  it('does not fire on a busy desk amending many different orders', () => {
    const spread = Array.from({ length: 20 }, (_, i) => churn(`o-${i}`, 2, 30_000)).flat();
    expect(detectRapidCancelReplace(window({ orderChurn: spread }))).toBeNull();
  });

  it('does not fire on a trader chasing a price a few times', () => {
    expect(detectRapidCancelReplace(window({ orderChurn: churn('o-1', 3, 40_000) }))).toBeNull();
  });

  /**
   * The lookback is wider than the window, so the *densest slice* is what
   * counts — not the total.
   *
   * Ten amendments spread evenly over five minutes is somebody working an
   * order through a slow morning. Counting the lookback's total would report it
   * as ten-in-a-minute and fire every time, which is how a detector becomes
   * noise. This is the case that makes the sliding window earn its place.
   */
  it('does not fire on churn spread thinly across the whole lookback', () => {
    expect(detectRapidCancelReplace(window({ orderChurn: churn('o-1', 10, 300_000) }))).toBeNull();
  });

  /**
   * And it still finds a burst that happened a few minutes ago rather than
   * right now — a sweep runs on a timer, so churn that ended ninety seconds ago
   * is churn a one-minute lookback would never see.
   */
  it('finds a dense burst anywhere in the lookback', () => {
    const shifted = churn('o-1', 10, 5_000).map((event) => ({
      ...event,
      atMs: event.atMs - 180_000,
    }));
    expect(detectRapidCancelReplace(window({ orderChurn: shifted }))?.evidence['observed']).toBe(
      10,
    );
  });

  it('counts cancellations as well as amendments', () => {
    const mixed = [...churn('o-1', 5, 10_000, 'MODIFIED'), ...churn('o-1', 5, 10_000, 'CANCELLED')];
    expect(detectRapidCancelReplace(window({ orderChurn: mixed }))).not.toBeNull();
  });

  it('ignores churn older than the lookback', () => {
    const old = churn('o-1', 20, 5_000).map((event) => ({
      ...event,
      atMs: event.atMs - 1_200_000,
    }));
    expect(detectRapidCancelReplace(window({ orderChurn: old }))).toBeNull();
  });

  /**
   * A caller that cannot see order events produces no signal rather than a
   * guess. A detector that cannot see is better than one that invents.
   */
  it('says nothing when the caller supplied no churn at all', () => {
    expect(detectRapidCancelReplace(window())).toBeNull();
  });

  it('escalates when the count is far past the threshold', () => {
    const heavy = detectRapidCancelReplace(window({ orderChurn: churn('o-1', 20, 30_000) }));
    expect(heavy?.severity).toBe(SignalSeverity.HIGH);
    const moderate = detectRapidCancelReplace(window({ orderChurn: churn('o-1', 9, 30_000) }));
    expect(moderate?.severity).toBe(SignalSeverity.MEDIUM);
  });
});

describe('the engine as a whole', () => {
  /**
   * The case the whole design turns on. This account trades all day, in size,
   * across instruments — and none of that is a signal. An engine that cannot
   * stay quiet about ordinary work has nothing useful to say about the rest.
   */
  it('says nothing at all about a busy, ordinary trading day', () => {
    const ordinary = window({
      orders: burst(40, 6 * 3_600_000, { volume: '1' }),
      closedPositions: Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        symbol: i % 2 === 0 ? 'XAUUSD' : 'EURUSD',
        openedAtMs: NOW - (i + 1) * 600_000,
        closedAtMs: NOW - (i + 1) * 600_000 + 240_000,
      })),
      exposure: [
        { symbol: 'XAUUSD', grossNotional: '180000' },
        { symbol: 'EURUSD', grossNotional: '140000' },
      ],
    });
    expect(detectAll(ordinary)).toEqual([]);
  });

  it('reports several patterns at once when several are present', () => {
    const busy = window({
      orders: [
        ...burst(20, 2_000, { volume: '1', price: '1.08', symbol: 'EURUSD', side: 'BUY' }),
        order({ volume: '80' }),
      ],
      exposure: [
        { symbol: 'XAUUSD', grossNotional: '450000' },
        { symbol: 'EURUSD', grossNotional: '10000' },
      ],
    });
    const codes = detectAll(busy).map((signal) => signal.code);
    expect(codes).toContain(SignalCode.ORDER_BURST);
    expect(codes).toContain(SignalCode.DUPLICATE_ORDER_ATTEMPTS);
    expect(codes).toContain(SignalCode.VOLUME_SPIKE);
    expect(codes).toContain(SignalCode.CONCENTRATION);
  });

  /**
   * A pattern in trading activity is not, on its own, ever the most serious
   * thing this platform can say. `CRITICAL` belongs to a balance that is not
   * backed by the ledger — where the system knows something is wrong rather than
   * merely unusual.
   */
  it('never raises anything to CRITICAL', () => {
    const extreme = window({
      orders: [...burst(200, 1_000, { volume: '1', price: '1.08' }), order({ volume: '9999' })],
      closedPositions: Array.from({ length: 50 }, (_, i) => ({
        id: `p${i}`,
        symbol: 'XAUUSD',
        openedAtMs: NOW - 10_000 - i * 100,
        closedAtMs: NOW - 10_000 - i * 100 + 200,
      })),
      exposure: [
        { symbol: 'XAUUSD', grossNotional: '9000000' },
        { symbol: 'EURUSD', grossNotional: '1' },
      ],
    });
    const signals = detectAll(extreme);
    expect(signals.length).toBeGreaterThan(2);
    expect(signals.every((s) => s.severity !== SignalSeverity.CRITICAL)).toBe(true);
  });

  /**
   * Thresholds are configuration, not constants. The right value for "too many
   * orders" depends on the desk, the instrument and the hour, and a threshold
   * that needs a deployment to change is one that gets worked around.
   */
  it('honours thresholds it is given rather than its own defaults', () => {
    const orders = burst(11, 9_000);
    expect(detectOrderBurst(window({ orders }))).toBeNull();
    expect(
      detectOrderBurst(window({ orders }), {
        ...DEFAULT_THRESHOLDS,
        orderBurst: { windowMs: 10_000, count: 5 },
      })?.code,
    ).toBe(SignalCode.ORDER_BURST);
  });

  /**
   * Every signal carries what it was made from. A signal a person cannot check
   * is a signal they have to trust, and nobody should have to trust an automated
   * accusation.
   */
  it('carries checkable evidence on every signal', () => {
    const signals = detectAll(
      window({
        orders: burst(20, 2_000, { volume: '1', price: '1.08' }),
      }),
    );
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(Object.keys(signal.evidence).length).toBeGreaterThan(1);
      expect(signal.message.length).toBeGreaterThan(0);
    }
  });
});
