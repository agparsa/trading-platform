import { describe, expect, it } from 'vitest';
import type { TradingSession } from '@tp/market-core';
import {
  endOfTradingDay,
  isSessionOpen,
  marketStatus,
  startOfTradingDay,
  zonedDayAndMinute,
} from './session';

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
   * The test that used to be here was named for this bug and could not detect
   * it:
   *
   * ```ts
   * const at = Date.UTC(2026, 9, 25, 1, 0, 0);
   * const expiry = endOfTradingDay('Europe/London', at);
   * expect(expiry - at).toBeLessThanOrEqual(25 * 3_600_000);
   * expect(expiry - at).toBeGreaterThan(0);
   * ```
   *
   * `minutesLeft` is at most 1440, so the gap is always between zero and
   * twenty-four hours — **every answer the function can return passes both
   * assertions**, including the wrong ones. It also picked 01:00 UTC, which on
   * that date is just *after* the shift, so no transition lay between the
   * instant and the midnight being computed: one of the few hours that day when
   * the naive arithmetic is right by luck.
   *
   * Replaced with the instants where it can actually be wrong — placed before
   * the shift, so the shift falls between the order and its expiry — and with a
   * sweep that does not depend on choosing them well.
   */
  it('lands on local midnight when the shift falls between the order and its expiry', () => {
    const cases = [
      // Spring forward: the naive sum used to land at 01:00 the next day, so a
      // DAY order outlived its day by an hour and could still fill.
      ['Europe/London', Date.UTC(2027, 2, 28, 0, 30)],
      ['America/New_York', Date.UTC(2027, 2, 14, 6, 30)],
      // Fall back: it used to land at 23:00 the same day — cancelled an hour
      // early, with nothing said.
      ['Europe/London', Date.UTC(2026, 9, 25, 0, 30)],
      ['America/New_York', Date.UTC(2026, 10, 1, 4, 30)],
    ] as const;

    for (const [zone, at] of cases) {
      const expiry = endOfTradingDay(zone, at);
      expect(zonedDayAndMinute(expiry, zone).minute, `${zone} @ ${at}`).toBe(0);
      expect(expiry).toBeGreaterThan(at);
      // And the day really was not 24 hours, so the case is exercising what it
      // claims to: a test that passed here on a 1440-minute day proves nothing.
      expect(expiry - at, `${zone} was not a shifting day`).not.toBe(
        (1440 - zonedDayAndMinute(at, zone).minute) * 60_000,
      );
    }
  });

  /**
   * The sweep, because choosing the failing instant by hand is how the last one
   * missed. Every minute of both transition days in four zones — including
   * Australia/Lord_Howe, whose shift is **thirty minutes**, which is the case
   * that disproves the "offsets move by whole hours" reasoning the code used to
   * lean on.
   */
  it('lands on local midnight for every minute of a transition day', () => {
    const days: ReadonlyArray<readonly [string, number]> = [
      ['Europe/London', Date.UTC(2027, 2, 28, 0, 0)],
      ['Europe/London', Date.UTC(2026, 9, 25, 0, 0)],
      ['America/New_York', Date.UTC(2027, 2, 14, 5, 0)],
      ['America/New_York', Date.UTC(2026, 10, 1, 4, 0)],
      ['Australia/Lord_Howe', Date.UTC(2026, 9, 3, 13, 0)],
      ['Australia/Lord_Howe', Date.UTC(2027, 3, 3, 15, 0)],
      // A control: an ordinary day must still come out right.
      ['Europe/London', Date.UTC(2026, 8, 18, 0, 0)],
    ];

    for (const [zone, startOfDayUtc] of days) {
      for (let offset = 0; offset < 26 * 60; offset += 1) {
        const at = startOfDayUtc + offset * 60_000;
        const expiry = endOfTradingDay(zone, at);
        expect(
          zonedDayAndMinute(expiry, zone).minute,
          `${zone} at +${offset}m from ${new Date(startOfDayUtc).toISOString()}`,
        ).toBe(0);
        expect(expiry, `${zone} expiry not after the order`).toBeGreaterThan(at);
        // Never more than a wall-clock day away.
        expect(expiry - at).toBeLessThanOrEqual(25 * 3_600_000);
      }
    }
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
      /**
       * `+ 1440 * 60_000` was the assertion here, and on an ordinary day it is
       * right. It is also the bug `endOfTradingDay` had, written down as the
       * expectation — a day whose wall clock reads 1440 minutes is 23 or 25
       * hours long twice a year. Asserting local midnight instead says the
       * thing that is true every day.
       */
      const end = endOfTradingDay(zone, start);
      expect(zonedDayAndMinute(end, zone).minute).toBe(0);
      expect(end).toBeGreaterThan(start);
      expect(start).toBeLessThanOrEqual(at);
      expect(at - start).toBeLessThan(25 * 60 * 60_000);
    }
  });

  /**
   * The same pairing on the days it can come apart. A day must start at local
   * midnight and end at the next one, whatever the clock did in between.
   */
  it('starts and ends a shifting day at local midnight', () => {
    for (const [zone, at] of [
      ['Europe/London', Date.UTC(2027, 2, 28, 12, 0)],
      ['Europe/London', Date.UTC(2026, 9, 25, 12, 0)],
      ['America/New_York', Date.UTC(2027, 2, 14, 12, 0)],
      ['America/New_York', Date.UTC(2026, 10, 1, 12, 0)],
      ['Australia/Lord_Howe', Date.UTC(2026, 9, 3, 20, 0)],
    ] as const) {
      const start = startOfTradingDay(zone, at);
      const end = endOfTradingDay(zone, start);
      expect(zonedDayAndMinute(start, zone).minute, `${zone} start`).toBe(0);
      expect(zonedDayAndMinute(end, zone).minute, `${zone} end`).toBe(0);
      expect(end - start).toBeGreaterThanOrEqual(23 * 3_600_000);
      expect(end - start).toBeLessThanOrEqual(25 * 3_600_000);
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

/**
 * The market's state, and the one rule that matters about it (§36).
 *
 * `sessionOpen` was a boolean, so a shut market could say nothing about when it
 * would not be. These states say it — and the risk of adding them is that a
 * state which merely *sounds* tradeable becomes one. PRE_OPEN is the obvious
 * trap: real exchanges accept orders into a pre-open auction, and this platform
 * does not. So the first test here is not about vocabulary at all.
 */
describe('marketStatus', () => {
  const NEVER: TradingSession = { symbol: 'NEW', timezone: 'UTC', windows: [] };

  it('lets exactly one state trade, and it is OPEN', () => {
    const seen = new Map<string, boolean>();
    // Sunday 15:00 (closed), Sunday 21:50 (pre-open), Sunday 23:00 (open),
    // Friday 21:05 (post-close), halted, and an unconfigured instrument.
    const options = { preOpenMinutes: 15, postCloseMinutes: 15 };
    for (const at of [
      utc(2026, 8, 23, 15),
      utc(2026, 8, 23, 21, 50),
      utc(2026, 8, 23, 23),
      utc(2026, 8, 28, 21, 5),
    ]) {
      const status = marketStatus(METALS, at, options);
      seen.set(status.state, status.tradeable);
    }
    seen.set('HALTED', marketStatus(METALS, utc(2026, 8, 23, 23), { halted: true }).tradeable);
    seen.set('UNKNOWN', marketStatus(NEVER, utc(2026, 8, 25, 12), options).tradeable);

    // Every state was actually reached — a rule about states nobody produced
    // would pass while proving nothing.
    expect([...seen.keys()].sort()).toEqual([
      'CLOSED',
      'HALTED',
      'OPEN',
      'POST_CLOSE',
      'PRE_OPEN',
      'UNKNOWN',
    ]);
    expect([...seen.entries()].filter(([, tradeable]) => tradeable)).toEqual([['OPEN', true]]);
  });

  it('agrees with isSessionOpen everywhere, because it is the same function', () => {
    // Every hour of a week, including both session edges.
    for (let hour = 0; hour < 24 * 7; hour += 1) {
      const at = utc(2026, 8, 23, 0) + hour * 3_600_000;
      expect(marketStatus(METALS, at).tradeable, `hour ${hour}`).toBe(isSessionOpen(METALS, at));
    }
  });

  it('a halt overrides an open market, and promises no reopening time', () => {
    const status = marketStatus(METALS, utc(2026, 8, 25, 12), { halted: true });
    expect(status).toEqual({ state: 'HALTED', tradeable: false, opensAt: null, closesAt: null });
  });

  it('tells an unconfigured instrument apart from a shut one', () => {
    expect(marketStatus(NEVER, utc(2026, 8, 25, 12)).state).toBe('UNKNOWN');
    expect(marketStatus(METALS, utc(2026, 8, 22, 12)).state).toBe('CLOSED');
  });

  it('says when a shut market opens, and how long an open one has left', () => {
    // Saturday: shut until Sunday 22:00 UTC.
    const saturday = marketStatus(METALS, utc(2026, 8, 22, 12));
    expect(saturday.state).toBe('CLOSED');
    expect(saturday.opensAt).toBe(utc(2026, 8, 23, 22));
    expect(saturday.closesAt).toBeNull();

    // Wednesday: open, and the week runs to Friday 21:00 UTC.
    const wednesday = marketStatus(METALS, utc(2026, 8, 26, 9));
    expect(wednesday.state).toBe('OPEN');
    expect(wednesday.closesAt).toBe(utc(2026, 8, 28, 21));
    expect(wednesday.opensAt).toBeNull();
  });

  /**
   * The reason the windows are merged. Metals are stored as seven rows —
   * Sunday 22:00–24:00, then a full Monday, and so on — which is one continuous
   * session. Unmerged, this would announce a close every midnight of the week.
   */
  it('does not close at midnight in the middle of a continuous week', () => {
    const beforeMidnight = marketStatus(METALS, utc(2026, 8, 25, 23, 59));
    expect(beforeMidnight.state).toBe('OPEN');
    expect(beforeMidnight.closesAt).toBe(utc(2026, 8, 28, 21));
  });

  it('never closes for crypto, and says so rather than inventing a date', () => {
    const status = marketStatus(CRYPTO, utc(2026, 8, 22, 12));
    expect(status.state).toBe('OPEN');
    expect(status.closesAt).toBeNull();
  });

  it('warns before the open, and explains itself after the close', () => {
    const options = { preOpenMinutes: 15, postCloseMinutes: 15 };
    // Sunday 21:50 UTC — ten minutes before the week opens.
    expect(marketStatus(METALS, utc(2026, 8, 23, 21, 50), options).state).toBe('PRE_OPEN');
    // …but twenty minutes before is still just closed.
    expect(marketStatus(METALS, utc(2026, 8, 23, 21, 40), options).state).toBe('CLOSED');
    // Friday 21:05 UTC — five minutes after the week ended.
    expect(marketStatus(METALS, utc(2026, 8, 28, 21, 5), options).state).toBe('POST_CLOSE');
    expect(marketStatus(METALS, utc(2026, 8, 28, 21, 20), options).state).toBe('CLOSED');
  });

  it('defaults to no notice period at all, so a caller opts in', () => {
    expect(marketStatus(METALS, utc(2026, 8, 23, 21, 59)).state).toBe('CLOSED');
  });

  it('prefers the coming open to the one just gone when a gap is both', () => {
    // Monday 09:00–12:00 and 13:00–17:00 New York: at 12:50 the gap is inside
    // both notice periods. A trader waiting at a screen cares what happens next.
    const gapped: TradingSession = {
      symbol: 'GAP',
      timezone: 'UTC',
      windows: [
        { day: 1, openMinute: 9 * 60, closeMinute: 12 * 60 },
        { day: 1, openMinute: 13 * 60, closeMinute: 17 * 60 },
      ],
    };
    const status = marketStatus(gapped, utc(2026, 8, 24, 12, 50), {
      preOpenMinutes: 15,
      postCloseMinutes: 60,
    });
    expect(status.state).toBe('PRE_OPEN');
    expect(status.opensAt).toBe(utc(2026, 8, 24, 13));
  });

  /**
   * The bug the old `nextOpenAt` carried unread: wall-clock minutes added as
   * elapsed milliseconds. On the day a zone shifts, a day is 23 or 25 hours
   * long, and the open lands an hour out.
   */
  it('lands the open on the right wall clock across a daylight-saving shift', () => {
    // US clocks go forward at 02:00 local on Sunday 8 March 2026. The window is
    // Monday 09:30 New York, which is 13:30 UTC in winter and 12:30 in summer.
    const beforeShift = marketStatus(NEW_YORK, utc(2026, 3, 6, 12));
    expect(beforeShift.opensAt).toBe(utc(2026, 3, 9, 13, 30));

    // The same question asked from inside the week after the shift.
    const afterShift = marketStatus(NEW_YORK, utc(2026, 3, 10, 12));
    expect(afterShift.opensAt).toBe(utc(2026, 3, 16, 13, 30));
  });
});
