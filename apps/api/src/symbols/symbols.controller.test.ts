import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstrumentDefinition } from '@tp/market-core';
import { SymbolsController } from './symbols.controller';
import { TradingState } from '../operations/kill-switch.service';

/**
 * What the symbols endpoint says about a market (§36).
 *
 * The point of this file is a case the smoke check cannot reach: on a weekday
 * every instrument is open, so an endpoint that hard-coded `sessionOpen: true`
 * would pass every HTTP check ever run against it and fail at a weekend. The
 * session is fixed here so the shut path is exercised on any day.
 */
const WEEKDAYS_ONLY: InstrumentDefinition = {
  spec: { code: 'XAUUSD' } as InstrumentDefinition['spec'],
  session: {
    symbol: 'XAUUSD',
    timezone: 'UTC',
    windows: [{ day: 1, openMinute: 9 * 60, closeMinute: 17 * 60 }],
  },
};
const NO_SESSION: InstrumentDefinition = {
  spec: { code: 'NEWCOIN' } as InstrumentDefinition['spec'],
  session: { symbol: 'NEWCOIN', timezone: 'UTC', windows: [] },
};

function controller(instruments: InstrumentDefinition[], halted = false) {
  const symbols = {
    list: () => instruments,
    require: (code: string) => instruments.find((i) => i.spec.code === code)!,
  };
  const killSwitch = {
    current: () => ({ state: halted ? TradingState.DISABLED : TradingState.ENABLED }),
  };
  const config = {
    get: (key: string) => ({ MARKET_PRE_OPEN_MINUTES: 15, MARKET_POST_CLOSE_MINUTES: 15 })[key],
  };
  return new SymbolsController(symbols as never, killSwitch as never, config as never);
}

/** Sunday — outside the weekday window, whatever day the suite runs on. */
const SUNDAY = Date.UTC(2026, 8, 13, 12, 0);
const MONDAY_MIDDAY = Date.UTC(2026, 8, 14, 12, 0);

describe('SymbolsController market state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('derives sessionOpen from the market state rather than deciding it again', () => {
    vi.setSystemTime(SUNDAY);
    const [shut] = controller([WEEKDAYS_ONLY]).list();
    expect(shut!.market.state).toBe('CLOSED');
    expect(shut!.market.tradeable).toBe(false);
    expect(shut!.sessionOpen).toBe(false);

    vi.setSystemTime(MONDAY_MIDDAY);
    const [open] = controller([WEEKDAYS_ONLY]).list();
    expect(open!.market.state).toBe('OPEN');
    expect(open!.sessionOpen).toBe(true);
  });

  it('reports the halt on every instrument, because the switch is not per-instrument', () => {
    vi.setSystemTime(MONDAY_MIDDAY);
    const listed = controller([WEEKDAYS_ONLY, NO_SESSION], true).list();
    expect(listed.map((item) => item.market.state)).toEqual(['HALTED', 'HALTED']);
    expect(listed.every((item) => !item.sessionOpen)).toBe(true);
  });

  it('tells an unconfigured instrument apart from a shut one, on the same list', () => {
    vi.setSystemTime(SUNDAY);
    const listed = controller([WEEKDAYS_ONLY, NO_SESSION]).list();
    expect(listed.map((item) => item.market.state)).toEqual(['CLOSED', 'UNKNOWN']);
    // The shut one knows when it opens; the unconfigured one must not pretend to.
    expect(listed[0]!.market.opensAt).toBe(Date.UTC(2026, 8, 14, 9));
    expect(listed[1]!.market.opensAt).toBeNull();
  });

  it('answers the single-instrument route the same way, halt included', () => {
    vi.setSystemTime(SUNDAY);
    const one = controller([WEEKDAYS_ONLY]).get('XAUUSD');
    expect(one.sessionOpen).toBe(false);
    expect(one.market.state).toBe('CLOSED');
    expect(one.session.windows).toHaveLength(1);

    // The route that serves one instrument must read the same switch as the
    // route that serves the list; a halt visible on one screen and not the
    // other is worse than a halt visible on neither.
    vi.setSystemTime(MONDAY_MIDDAY);
    expect(controller([WEEKDAYS_ONLY], true).get('XAUUSD').market.state).toBe('HALTED');
    expect(controller([WEEKDAYS_ONLY], true).get('XAUUSD').sessionOpen).toBe(false);
  });

  /**
   * The notice periods are configuration, and configuration that is read but
   * never passed on looks exactly like configuration that works.
   */
  it('passes the configured notice periods through, so PRE_OPEN can happen at all', () => {
    // Monday 08:50 UTC — ten minutes before the 09:00 window.
    vi.setSystemTime(Date.UTC(2026, 8, 14, 8, 50));
    const [instrument] = controller([WEEKDAYS_ONLY]).list();
    expect(instrument!.market.state).toBe('PRE_OPEN');
    expect(instrument!.market.opensAt).toBe(Date.UTC(2026, 8, 14, 9));
    expect(instrument!.sessionOpen).toBe(false);

    // Monday 17:10 — ten minutes after it closed.
    vi.setSystemTime(Date.UTC(2026, 8, 14, 17, 10));
    expect(controller([WEEKDAYS_ONLY]).list()[0]!.market.state).toBe('POST_CLOSE');
  });
});
