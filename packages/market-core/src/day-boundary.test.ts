import { describe, expect, it } from 'vitest';
import { bucketStart } from './candles';
import { Resolution } from './types';

/**
 * What a "day" is here, pinned — because this platform has three answers and
 * they are not interchangeable.
 *
 * | Surface | A day is | Where |
 * | --- | --- | --- |
 * | today's P&L, DAY order expiry, swap accrual, report windows | midnight in `TRADING_SERVER_TIMEZONE` | `startOfTradingDay` |
 * | session windows | the instrument's own IANA zone, per symbol | `MarketSession.timezone` |
 * | a `1D` candle | **midnight UTC**, always | `bucketStart`, here |
 *
 * The third is the one a reader would not guess. `bucketStart` aligns to the
 * epoch grid, which its comment says plainly — so the code is honest — but
 * nothing anywhere said that the daily bar therefore ignores the trading
 * server's timezone entirely. On a broker at UTC+2, which is the ordinary FX
 * arrangement, the daily candle opens at 02:00 local while everything else the
 * trader sees rolls over at midnight local.
 *
 * **This test does not assert that the UTC grid is right.** It asserts that it
 * is what the platform does, so that changing it is a decision somebody takes
 * on purpose — the stored `candles` rows are keyed by this bucket start, so a
 * change is a migration and a backfill, not an edit. See `market-data.md`.
 */
describe('what a day is, for a candle', () => {
  it('buckets a 1D candle on UTC midnight, whatever the trading server is set to', () => {
    // 23:30 UTC on 1 March is already 08:30 on 2 March in Tokyo.
    const lateOnTheFirst = Date.parse('2026-03-01T23:30:00.000Z');
    expect(new Date(bucketStart(lateOnTheFirst, Resolution.D1)).toISOString()).toBe(
      '2026-03-01T00:00:00.000Z',
    );

    // And 00:30 UTC on 2 March is still 1 March in New York.
    const earlyOnTheSecond = Date.parse('2026-03-02T00:30:00.000Z');
    expect(new Date(bucketStart(earlyOnTheSecond, Resolution.D1)).toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    );
  });

  /**
   * A daylight-saving change moves no candle boundary, because UTC has none.
   * That is a consequence of the choice rather than a defect: the bars stay a
   * fixed 24 hours while the trading day around them is 23 or 25.
   */
  it('keeps a 24-hour bar across a clock change, unlike the trading day', () => {
    const before = bucketStart(Date.parse('2026-10-25T00:30:00.000Z'), Resolution.D1);
    const after = bucketStart(Date.parse('2026-10-26T00:30:00.000Z'), Resolution.D1);
    expect(after - before).toBe(24 * 3_600_000);
  });

  /** H4 sits on the same grid: 00, 04, 08, 12, 16, 20 UTC. */
  it('buckets H4 on the UTC grid too, so the last bar of a local day straddles it', () => {
    for (const [at, expected] of [
      ['2026-03-01T03:59:59.999Z', '2026-03-01T00:00:00.000Z'],
      ['2026-03-01T04:00:00.000Z', '2026-03-01T04:00:00.000Z'],
      ['2026-03-01T23:59:59.999Z', '2026-03-01T20:00:00.000Z'],
    ] as const) {
      expect(new Date(bucketStart(Date.parse(at), Resolution.H4)).toISOString()).toBe(expected);
    }
  });
});
