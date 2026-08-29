import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TICK_GATE,
  inspectTick,
  isBookSane,
  TickGate,
  TickRejection,
  type TickGateConfig,
} from './integrity';
import type { Tick } from './types';

const NOW = 1_756_000_000_000;

const tick = (overrides: Partial<Tick> = {}): Tick => ({
  symbol: 'XAUUSD',
  bid: '4583.58',
  ask: '4583.72',
  timestamp: NOW,
  volume: '1',
  ...overrides,
});

const config = (overrides: Partial<TickGateConfig> = {}): TickGateConfig => ({
  ...DEFAULT_TICK_GATE,
  ...overrides,
});

describe('inspectTick', () => {
  it('accepts an ordinary tick', () => {
    expect(inspectTick(tick(), null, config(), NOW).accepted).toBe(true);
  });

  it('accepts the first tick for a symbol, with nothing to compare against', () => {
    const verdict = inspectTick(tick({ bid: '1.08750', ask: '1.08755' }), null, config(), NOW);
    expect(verdict.accepted).toBe(true);
  });

  // ── Impossible data ──────────────────────────────────────────────────────

  it('refuses a crossed book', () => {
    const verdict = inspectTick(tick({ bid: '4583.72', ask: '4583.58' }), null, config(), NOW);
    expect(verdict.reason).toBe(TickRejection.CROSSED);
  });

  it('refuses a book with no spread at all', () => {
    const verdict = inspectTick(tick({ bid: '4583.58', ask: '4583.58' }), null, config(), NOW);
    expect(verdict.reason).toBe(TickRejection.CROSSED);
  });

  it('refuses a zero or negative price', () => {
    expect(inspectTick(tick({ bid: '0' }), null, config(), NOW).reason).toBe(
      TickRejection.NON_POSITIVE,
    );
    expect(inspectTick(tick({ bid: '-1', ask: '1' }), null, config(), NOW).reason).toBe(
      TickRejection.NON_POSITIVE,
    );
  });

  it('refuses a price that is not a number', () => {
    expect(inspectTick(tick({ bid: 'NaN' }), null, config(), NOW).reason).toBe(
      TickRejection.MALFORMED,
    );
    expect(inspectTick(tick({ ask: '' }), null, config(), NOW).reason).toBe(
      TickRejection.MALFORMED,
    );
    expect(inspectTick(tick({ timestamp: Number.NaN }), null, config(), NOW).reason).toBe(
      TickRejection.MALFORMED,
    );
  });

  /**
   * A tick from the future passes every freshness check for as long as the skew
   * lasts, so a feed that has actually died goes on looking alive.
   */
  it('refuses a tick timestamped beyond the tolerated clock skew', () => {
    const verdict = inspectTick(tick({ timestamp: NOW + 60_000 }), null, config(), NOW);
    expect(verdict.reason).toBe(TickRejection.FUTURE);
  });

  it('tolerates skew inside the allowance', () => {
    expect(inspectTick(tick({ timestamp: NOW + 1_000 }), null, config(), NOW).accepted).toBe(true);
  });

  // ── Ordering ─────────────────────────────────────────────────────────────

  /**
   * The one that is invisible without a test. An older tick replacing a newer
   * one silently rewinds the price, and the rewound price then decides whether
   * a stop fires.
   */
  it('refuses a tick older than the one already accepted', () => {
    const previous = tick({ timestamp: NOW });
    const verdict = inspectTick(tick({ timestamp: NOW - 500 }), previous, config(), NOW);
    expect(verdict.reason).toBe(TickRejection.OUT_OF_ORDER);
  });

  it('accepts a tick at the same millisecond as the last', () => {
    const previous = tick({ timestamp: NOW });
    expect(inspectTick(tick({ timestamp: NOW }), previous, config(), NOW).accepted).toBe(true);
  });

  // ── Plausibility ─────────────────────────────────────────────────────────

  it('refuses an implausibly wide spread', () => {
    const verdict = inspectTick(tick({ bid: '4000.00', ask: '4600.00' }), null, config(), NOW);
    expect(verdict.reason).toBe(TickRejection.SPREAD);
    expect(verdict.detail).toContain('%');
  });

  it('accepts a wide spread when the check is switched off', () => {
    const verdict = inspectTick(
      tick({ bid: '4000.00', ask: '4600.00' }),
      null,
      config({ maxSpreadRatio: null }),
      NOW,
    );
    expect(verdict.accepted).toBe(true);
  });

  it('refuses a mid that jumped further than the limit in one tick', () => {
    const previous = tick();
    const verdict = inspectTick(
      tick({ bid: '9000.00', ask: '9000.20', timestamp: NOW + 250 }),
      previous,
      config(),
      NOW + 250,
    );
    expect(verdict.reason).toBe(TickRejection.SPIKE);
  });

  it('accepts a move inside the limit', () => {
    const previous = tick();
    const verdict = inspectTick(
      tick({ bid: '4600.00', ask: '4600.14', timestamp: NOW + 250 }),
      previous,
      config(),
      NOW + 250,
    );
    expect(verdict.accepted).toBe(true);
  });

  /**
   * Decimal, not float. A gate that compared with Number would be a gate
   * protecting money with the arithmetic this platform bans everywhere else.
   */
  it('judges prices with more precision than a double carries', () => {
    const previous = tick({ bid: '0.100000000000000001', ask: '0.100000000000000003' });
    const next = tick({
      bid: '0.100000000000000002',
      ask: '0.100000000000000001',
      timestamp: NOW + 1,
    });
    expect(inspectTick(next, previous, config(), NOW + 1).reason).toBe(TickRejection.CROSSED);
  });
});

describe('TickGate', () => {
  it('remembers the last accepted tick per symbol', () => {
    const gate = new TickGate();
    gate.admit(tick(), NOW);
    gate.admit(tick({ symbol: 'EURUSD', bid: '1.08750', ask: '1.08755' }), NOW);

    expect(gate.last('XAUUSD')?.bid).toBe('4583.58');
    expect(gate.last('EURUSD')?.bid).toBe('1.08750');
    expect(gate.size).toBe(2);
  });

  it('does not remember a tick it refused', () => {
    const gate = new TickGate();
    gate.admit(tick(), NOW);
    gate.admit(tick({ bid: '4583.72', ask: '4583.58', timestamp: NOW + 1 }), NOW + 1);
    expect(gate.last('XAUUSD')?.timestamp).toBe(NOW);
  });

  it('keeps one symbol from affecting another', () => {
    const gate = new TickGate();
    gate.admit(tick({ timestamp: NOW }), NOW);
    // An older EURUSD tick is fine; EURUSD has no history.
    const verdict = gate.admit(
      tick({ symbol: 'EURUSD', bid: '1.08750', ask: '1.08755', timestamp: NOW - 5_000 }),
      NOW,
    );
    expect(verdict.accepted).toBe(true);
  });

  /**
   * The design point. A gate that never re-opens freezes the price forever, and
   * the engine goes on marking positions against an anchor that stopped moving
   * — silently, and with every appearance of working.
   */
  it('re-anchors after a run of plausibility rejections', () => {
    const gate = new TickGate({ reanchorAfter: 3 });
    gate.admit(tick(), NOW);

    const spike = (n: number) => tick({ bid: '9000.00', ask: '9000.20', timestamp: NOW + n * 250 });

    expect(gate.admit(spike(1), NOW + 250).accepted).toBe(false);
    expect(gate.admit(spike(2), NOW + 500).accepted).toBe(false);

    const third = gate.admit(spike(3), NOW + 750);
    expect(third.accepted).toBe(true);
    expect(third.reanchored).toBe(true);
    expect(third.reason).toBe(TickRejection.SPIKE);
    expect(gate.last('XAUUSD')?.bid).toBe('9000.00');
  });

  it('re-anchors on a persistently wide spread too', () => {
    const gate = new TickGate({ reanchorAfter: 2 });
    gate.admit(tick(), NOW);
    const wide = (n: number) => tick({ bid: '4000.00', ask: '4600.00', timestamp: NOW + n * 250 });

    expect(gate.admit(wide(1), NOW + 250).accepted).toBe(false);
    expect(gate.admit(wide(2), NOW + 500).reanchored).toBe(true);
  });

  /**
   * The other half. Broken data does not become valid by repeating; accepting a
   * crossed book after five of them would only corrupt prices more slowly.
   */
  it('never re-anchors on a crossed book, however many arrive', () => {
    const gate = new TickGate({ reanchorAfter: 2 });
    gate.admit(tick(), NOW);
    for (let i = 1; i <= 10; i += 1) {
      const verdict = gate.admit(
        tick({ bid: '4600.00', ask: '4500.00', timestamp: NOW + i * 250 }),
        NOW + i * 250,
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.reason).toBe(TickRejection.CROSSED);
    }
    expect(gate.last('XAUUSD')?.bid).toBe('4583.58');
  });

  it('never re-anchors on an out-of-order tick', () => {
    const gate = new TickGate({ reanchorAfter: 2 });
    gate.admit(tick({ timestamp: NOW }), NOW);
    for (let i = 1; i <= 5; i += 1) {
      expect(gate.admit(tick({ timestamp: NOW - 1_000 }), NOW).accepted).toBe(false);
    }
  });

  it('forgets the run once a good tick arrives', () => {
    const gate = new TickGate({ reanchorAfter: 3 });
    gate.admit(tick(), NOW);
    gate.admit(tick({ bid: '9000.00', ask: '9000.20', timestamp: NOW + 250 }), NOW + 250);
    expect(gate.rejectionRun('XAUUSD')).toBe(1);

    gate.admit(tick({ bid: '4583.60', ask: '4583.74', timestamp: NOW + 500 }), NOW + 500);
    expect(gate.rejectionRun('XAUUSD')).toBe(0);
  });

  it('treats a reanchorAfter below one as one', () => {
    const gate = new TickGate({ reanchorAfter: 0 });
    gate.admit(tick(), NOW);
    // The very first spike re-anchors rather than dividing by zero or looping.
    const verdict = gate.admit(
      tick({ bid: '9000.00', ask: '9000.20', timestamp: NOW + 250 }),
      NOW + 250,
    );
    expect(verdict.reanchored).toBe(true);
  });

  it('drops a symbol on request', () => {
    const gate = new TickGate();
    gate.admit(tick(), NOW);
    gate.forget('XAUUSD');
    expect(gate.last('XAUUSD')).toBeNull();
  });
});

describe('isBookSane', () => {
  it('accepts a normal book and refuses a broken one', () => {
    expect(isBookSane(tick())).toBe(true);
    expect(isBookSane(tick({ bid: '4583.72', ask: '4583.58' }))).toBe(false);
    expect(isBookSane(tick({ bid: '0', ask: '1' }))).toBe(false);
    expect(isBookSane(tick({ bid: 'x', ask: '1' }))).toBe(false);
  });
});
