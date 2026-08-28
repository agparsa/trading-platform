import { describe, expect, it } from 'vitest';
import type { TradingSession } from '@tp/market-core';
import { endOfTradingDay, isSessionOpen, startOfTradingDay, zonedDayAndMinute } from './session';

/** Sunday 22:00 → Friday 21:00 UTC, the usual metals and FX week. */
const METALS: TradingSession = {
  symbol: 'XAUUSD',
  timezone: 'UTC',
  windows: [
    { day: 0, openMinute: 22 * 60, closeMinute: 24 * 60 },
    { day: 1, openMinute: 0, closeMinute: 24 * 60 },
    { day: 2, openMinute: 0, closeMinute: 24 * 60 },
    { day: 3, openMinute: 0, closeMinute: 24 * 60 },
    { day: 4, openMinute: 0, closeMinute: 24 * 60 },
    { day: 5, openMinute: 0, closeMinute: 21 * 60 },
  ],
};

const CRYPTO: TradingSession = {
  symbol: 'BTCUSD',
  timezone: 'UTC',
  windows: Array.from({ length: 7 }, (_, day) => ({ day, openMinute: 0, closeMinute: 1440 })),
};

/** Same windows expressed in New York time — the DST case. */
const NEW_YORK: TradingSession = {
  symbol: 'TEST',
  timezone: 'America/New_York',
  windows: [{ day: 1, openMinute: 9 * 60 + 30, closeMinute: 16 * 60 }],
};

const utc = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min);

describe('zonedDayAndMinute', () => {
  it('reads the weekday and minute in the session’s own zone', () => {
    // 2026-08-23 is a Sunday.
    expect(zonedDayAndMinute(utc(2026, 8, 23, 15, 27), 'UTC')).toEqual({ day: 0, minute: 927 });
  });

  it('shifts the day when the zone crosses midnight', () => {
    // 01:30 UTC Monday is 21:30 Sunday in New York.
    expect(zonedDayAndMinute(utc(2026, 8, 24, 1, 30), 'America/New_York')).toEqual({
      day: 0,
      minute: 21 * 60 + 30,
    });
  });

  it('follows daylight saving rather than a fixed offset', () => {
    // January: New York is UTC-5. July: UTC-4. The same UTC hour lands on
    // different local minutes, which a hardcoded offset would get wrong twice a year.
    const winter = zonedDayAndMinute(utc(2026, 1, 15, 17, 0), 'America/New_York');
    const summer = zonedDayAndMinute(utc(2026, 7, 15, 17, 0), 'America/New_York');
    expect(winter.minute).toBe(12 * 60);
    expect(summer.minute).toBe(13 * 60);
  });
});

describe('isSessionOpen', () => {
  it('is closed on a Sunday afternoon and open on Sunday evening', () => {
    expect(isSessionOpen(METALS, utc(2026, 8, 23, 15, 27))).toBe(false);
    expect(isSessionOpen(METALS, utc(2026, 8, 23, 22, 0))).toBe(true);
  });

  it('is open through the middle of the week', () => {
    expect(isSessionOpen(METALS, utc(2026, 8, 26, 12, 0))).toBe(true);
  });

  it('closes on Friday evening and stays closed all Saturday', () => {
    expect(isSessionOpen(METALS, utc(2026, 8, 28, 20, 59))).toBe(true);
    expect(isSessionOpen(METALS, utc(2026, 8, 28, 21, 0))).toBe(false);
    expect(isSessionOpen(METALS, utc(2026, 8, 29, 12, 0))).toBe(false);
  });

  it('treats the close minute as exclusive, so windows cannot overlap', () => {
    expect(isSessionOpen(METALS, utc(2026, 8, 24, 0, 0))).toBe(true);
  });

  it('never closes for crypto', () => {
    for (const day of [22, 23, 24, 25, 26, 27, 28]) {
      expect(isSessionOpen(CRYPTO, utc(2026, 8, day, 3, 0))).toBe(true);
    }
  });

  it('evaluates a non-UTC session in its own zone', () => {
    // 2026-08-24 is a Monday. 14:00 UTC is 10:00 in New York — inside the window.
    expect(isSessionOpen(NEW_YORK, utc(2026, 8, 24, 14, 0))).toBe(true);
    // 21:00 UTC is 17:00 New York — after the close.
    expect(isSessionOpen(NEW_YORK, utc(2026, 8, 24, 21, 0))).toBe(false);
    // 13:00 UTC is 09:00 New York — before the open.
    expect(isSessionOpen(NEW_YORK, utc(2026, 8, 24, 13, 0))).toBe(false);
  });

  it('is closed when an instrument has no windows at all', () => {
    expect(isSessionOpen({ symbol: 'X', timezone: 'UTC', windows: [] }, Date.now())).toBe(false);
  });
});

describe('endOfTradingDay', () => {
  /**
   * A DAY order's expiry is fixed when it is placed, so nothing downstream has
   * to decide what a "day" means — and a server that changes timezone cannot
   * reinterpret an order already resting.
   */
  it('returns the next midnight in the trading server timezone', () => {
    // 2026-08-25T14:32:11Z
    const at = Date.UTC(2026, 7, 25, 14, 32, 11);
    const expiry = endOfTradingDay('UTC', at);
    expect(new Date(expiry).toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });

  it('is always in the future, even a second before midnight', () => {
    const at = Date.UTC(2026, 7, 25, 23, 59, 59);
    const expiry = endOfTradingDay('UTC', at);
    expect(expiry).toBeGreaterThan(at);
    expect(new Date(expiry).toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });

  it('measures the day in the configured zone, not the host’s', () => {
    // 23:30 UTC is 08:30 the next morning in Tokyo. UTC has half an hour of its
    // day left; Tokyo has just started one, so Tokyo's expiry is much later.
    const at = Date.UTC(2026, 7, 25, 23, 30, 0);
    const utc = endOfTradingDay('UTC', at);
    const tokyo = endOfTradingDay('Asia/Tokyo', at);
    expect(utc - at).toBe(30 * 60_000);
    expect(tokyo).toBeGreaterThan(utc);
    expect(tokyo - at).toBe(15.5 * 3_600_000);
  });

  /**
   * On the day a zone shifts, midnight is 23 or 25 hours away rather than 24.
   * Date arithmetic would get this wrong; `zonedDayAndMinute` does not.
   */
  it('handles a daylight-saving transition', () => {
    // 2026-10-25 is the UK clock change; 01:00 UTC is 01:00 local after it.
    const at = Date.UTC(2026, 9, 25, 1, 0, 0);
    const expiry = endOfTradingDay('Europe/London', at);
    expect(expiry - at).toBeLessThanOrEqual(25 * 3_600_000);
    expect(expiry - at).toBeGreaterThan(0);
  });
});

describe('startOfTradingDay', () => {
  /**
   * Paired with `endOfTradingDay` rather than tested against hand-written
   * timestamps: the property that matters is that a day starts where the
   * previous one ended, and asserting it directly is harder to get wrong than
   * two independent literal expectations.
   */
  it('starts a day exactly where the previous one ended', () => {
    for (const zone of ['UTC', 'Europe/London', 'America/New_York', 'Asia/Tokyo']) {
      const at = Date.UTC(2026, 6, 15, 13, 47, 31);
      const start = startOfTradingDay(zone, at);
      expect(endOfTradingDay(zone, start)).toBe(start + 1440 * 60_000);
      expect(start).toBeLessThanOrEqual(at);
      expect(at - start).toBeLessThan(25 * 60 * 60_000);
    }
  });

  it('lands on local midnight, not on UTC midnight', () => {
    // 2026-07-15 13:47 UTC is 22:47 in Tokyo on the 15th, so the Tokyo day
    // began at 15:00 UTC on the 14th — a different calendar date entirely.
    const at = Date.UTC(2026, 6, 15, 13, 47, 0);
    expect(startOfTradingDay('Asia/Tokyo', at)).toBe(Date.UTC(2026, 6, 14, 15, 0, 0));
    expect(startOfTradingDay('UTC', at)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  /**
   * The case the correction pass exists for. On 2026-03-29 Europe/London
   * springs forward at 01:00, so that local day is 23 hours long and a plain
   * "subtract the wall-clock minutes elapsed" lands an hour before midnight.
   */
  it('lands on midnight on a day that loses an hour', () => {
    const afterTheShift = Date.UTC(2026, 2, 29, 12, 0, 0);
    const start = startOfTradingDay('Europe/London', afterTheShift);
    expect(zonedDayAndMinute(start, 'Europe/London').minute).toBe(0);
    expect(start).toBe(Date.UTC(2026, 2, 29, 0, 0, 0));
  });

  /** And the day that gains one: 2026-10-25, London falls back at 02:00. */
  it('lands on midnight on a day that gains an hour', () => {
    const afterTheShift = Date.UTC(2026, 9, 25, 12, 0, 0);
    const start = startOfTradingDay('Europe/London', afterTheShift);
    expect(zonedDayAndMinute(start, 'Europe/London').minute).toBe(0);
    expect(start).toBe(Date.UTC(2026, 9, 24, 23, 0, 0));
  });
});
