import { describe, expect, it } from 'vitest';
import { toDecimal } from '@tp/financial-core';
import { ManualClock } from '../clock';
import { Resolution } from '../types';
import { InternalMarketSimulator } from './simulator';
import { T0, XAUUSD_SIMULATED } from '../__fixtures__/market';

const build = (seed = 20260821) =>
  new InternalMarketSimulator({
    instruments: [XAUUSD_SIMULATED],
    seed,
    clock: new ManualClock(T0),
    resolutions: [Resolution.M1],
  });

const run = async (sim: InternalMarketSimulator, clock: ManualClock, steps: number) => {
  await sim.start();
  const ticks = [];
  for (let i = 0; i < steps; i += 1) {
    clock.advance(250);
    ticks.push(...sim.pump());
  }
  return ticks;
};

describe('InternalMarketSimulator', () => {
  it('produces nothing before start()', () => {
    const sim = build();
    expect(sim.pump()).toHaveLength(0);
  });

  it('replays an identical tick sequence for the same seed', async () => {
    const clockA = new ManualClock(T0);
    const simA = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 42,
      clock: clockA,
      resolutions: [Resolution.M1],
    });
    const clockB = new ManualClock(T0);
    const simB = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 42,
      clock: clockB,
      resolutions: [Resolution.M1],
    });

    const a = await run(simA, clockA, 200);
    const b = await run(simB, clockB, 200);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(100);
  });

  it('diverges for a different seed', async () => {
    const clockA = new ManualClock(T0);
    const simA = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 1,
      clock: clockA,
      resolutions: [Resolution.M1],
    });
    const clockB = new ManualClock(T0);
    const simB = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 2,
      clock: clockB,
      resolutions: [Resolution.M1],
    });
    const a = await run(simA, clockA, 20);
    const b = await run(simB, clockB, 20);
    expect(a).not.toEqual(b);
  });

  it('always quotes a positive, correctly ordered book on the tick grid', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 7,
      clock,
      resolutions: [Resolution.M1],
    });
    const ticks = await run(sim, clock, 500);
    for (const t of ticks) {
      const bid = toDecimal(t.bid);
      const ask = toDecimal(t.ask);
      expect(bid.gt(0)).toBe(true);
      expect(ask.gt(bid)).toBe(true);
      expect(bid.decimalPlaces()).toBeLessThanOrEqual(2);
      expect(ask.decimalPlaces()).toBeLessThanOrEqual(2);
    }
  });

  /**
   * A jump fills in the grid, up to a bound.
   *
   * Unbounded catch-up was a real problem, not a theoretical one: a process
   * paused for a minute would emit hundreds of back-dated ticks in one pass and
   * spend the recovery replaying a history nobody watched.
   */
  it('fills in a time jump, but not without limit', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 3,
      clock,
      resolutions: [Resolution.M1],
    });
    await sim.start();
    clock.advance(10_000); // 40 x 250ms

    const ticks = sim.pump();
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  /**
   * The bug a load run found, and the reason the schedule re-anchors.
   *
   * The pump used to advance each instrument's schedule by exactly one interval
   * per tick emitted, from wherever it started. A loop that runs a little late
   * every pass — and every timer does — left the timestamps on their original
   * grid while the wall clock moved on. Within a minute of load the newest
   * "current" price was stamped fourteen seconds ago, `requireFresh` refused
   * every order with STALE_QUOTE, and it was right to: a price observed fourteen
   * seconds ago is not one to trade on. The engine was correct. The timestamp
   * was a lie.
   */
  it('stamps the newest tick with the time it was actually produced', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 3,
      clock,
      resolutions: [Resolution.M1],
    });
    await sim.start();

    clock.advance(10_000);
    const late = sim.pump();
    expect(late[late.length - 1]?.timestamp).toBe(T0 + 10_000);
  });

  it('does not accumulate drift when every pass runs late', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 3,
      clock,
      resolutions: [Resolution.M1],
    });
    await sim.start();

    // Forty passes, each one 400ms apart for a 250ms grid: always late, never
    // catching up. The old schedule fell 150ms further behind every pass.
    let newest = T0;
    for (let i = 0; i < 40; i += 1) {
      clock.advance(400);
      const ticks = sim.pump();
      if (ticks.length > 0) newest = ticks[ticks.length - 1]!.timestamp;
    }

    // The newest observation is the present, not six seconds ago.
    expect(clock.now() - newest).toBe(0);
  });

  it('keeps a punctual grid exactly as it was', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 3,
      clock,
      resolutions: [Resolution.M1],
    });
    await sim.start();

    // The first pass also clears the tick due at start(), as it always did.
    clock.advance(250);
    expect(sim.pump()).toHaveLength(2);

    // After that, one interval is one tick, stamped at the moment.
    for (let i = 0; i < 5; i += 1) {
      clock.advance(250);
      const ticks = sim.pump();
      expect(ticks).toHaveLength(1);
      expect(ticks[0]?.timestamp).toBe(clock.now());
    }
  });

  it('delivers ticks to subscribers and stops after unsubscribe', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 5,
      clock,
      resolutions: [Resolution.M1],
    });
    const seen: string[] = [];
    const off = sim.subscribe('XAUUSD', (t) => seen.push(t.bid));
    await run(sim, clock, 5);
    const afterSubscribe = seen.length;
    expect(afterSubscribe).toBeGreaterThan(0);
    off();
    await run(sim, clock, 5);
    expect(seen).toHaveLength(afterSubscribe);
  });

  it('builds queryable candle history from its own ticks', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 11,
      clock,
      resolutions: [Resolution.M1],
    });
    await run(sim, clock, 1200); // 5 minutes at 250ms
    const candles = await sim.getCandles('XAUUSD', Resolution.M1, T0, T0 + 10 * 60_000);
    expect(candles.length).toBeGreaterThanOrEqual(5);
    for (const c of candles) {
      expect(toDecimal(c.high).gte(toDecimal(c.low))).toBe(true);
      expect(toDecimal(c.high).gte(toDecimal(c.open))).toBe(true);
      expect(toDecimal(c.low).lte(toDecimal(c.close))).toBe(true);
    }
  });

  it('exposes the latest tick for quote lookups', async () => {
    const clock = new ManualClock(T0);
    const sim = new InternalMarketSimulator({
      instruments: [XAUUSD_SIMULATED],
      seed: 13,
      clock,
      resolutions: [Resolution.M1],
    });
    expect(await sim.getLatestTick('XAUUSD')).toBeNull();
    const ticks = await run(sim, clock, 3);
    expect(await sim.getLatestTick('XAUUSD')).toEqual(ticks[ticks.length - 1]);
  });
});
