import { describe, expect, it } from 'vitest';
import type { TradingSession } from '@tp/market-core';
import { isSessionOpen, zonedDayAndMinute } from './session';

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
