import { describe, expect, it } from 'vitest';
import {
  LevelKind,
  levelIdentity,
  levelsFor,
  modificationFor,
  outcomeAt,
  pendingLevelsFor,
  priceFromDrag,
  priceFromPendingDrag,
} from './chart-levels';
import type { PendingOrderRow, PositionRow, SymbolRow } from './queries';

const XAUUSD: SymbolRow = {
  code: 'XAUUSD',
  description: 'Gold vs US Dollar',
  quoteCurrency: 'USD',
  contractSize: '100',
  tickSize: '0.01',
  pricePrecision: 2,
  volumeStep: '0.01',
  volumePrecision: 2,
  minVolume: '0.01',
  maxVolume: '50',
  marginRate: '0.01',
  commissionPerLot: '5',
  swapLongPerLot: '-2.5',
  swapShortPerLot: '1.2',
  enabled: true,
  sessionOpen: true,
};

function position(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    id: 'p1',
    symbol: 'XAUUSD',
    side: 'BUY',
    status: 'OPEN',
    volume: '1',
    initialVolume: '1',
    entryPrice: '4583.72',
    currentPrice: '4583.58',
    stopLoss: '4580.00',
    takeProfit: '4590.00',
    trailingStopDistance: null,
    highWaterPrice: null,
    margin: '4583.72',
    commission: '5.00',
    swap: '0.00',
    realizedPnl: '0.00',
    closeReason: null,
    openedAt: '2026-08-28T09:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

describe('levelsFor', () => {
  it('draws entry, stop and target for an open position', () => {
    const levels = levelsFor([position()], 'XAUUSD');
    expect(levels.map((level) => level.kind)).toEqual([
      LevelKind.ENTRY,
      LevelKind.STOP_LOSS,
      LevelKind.TAKE_PROFIT,
    ]);
    expect(levels[1]?.price).toBe('4580.00');
  });

  /**
   * A stop belonging to a position in gold means nothing drawn across a chart of
   * the euro — and drawing it would invite somebody to drag it, which would move
   * a level on an instrument they are not looking at.
   */
  it('draws nothing for a position in another instrument', () => {
    expect(levelsFor([position({ symbol: 'EURUSD' })], 'XAUUSD')).toEqual([]);
    expect(levelsFor([position()], undefined)).toEqual([]);
  });

  it('draws nothing for a position that is no longer open', () => {
    expect(levelsFor([position({ status: 'CLOSED' })], 'XAUUSD')).toEqual([]);
    // CLOSING is still on the books and its stop still matters.
    expect(levelsFor([position({ status: 'CLOSING' })], 'XAUUSD').length).toBeGreaterThan(0);
  });

  it('omits a level the position does not have, rather than drawing a zero', () => {
    const levels = levelsFor([position({ stopLoss: null, takeProfit: null })], 'XAUUSD');
    expect(levels).toHaveLength(1);
    expect(levels[0]?.kind).toBe(LevelKind.ENTRY);
  });

  it('never lets the entry line be dragged', () => {
    const entry = levelsFor([position()], 'XAUUSD')[0];
    expect(entry?.draggable).toBe(false);
  });

  /**
   * A trailing stop stays draggable. The trader may tighten it by hand and the
   * engine carries on from wherever they leave it; refusing the drag would make
   * the safer stop the harder one to set.
   */
  it('marks a trailing stop as trailing and still lets it be moved', () => {
    const levels = levelsFor([position({ trailingStopDistance: '5.00' })], 'XAUUSD');
    const stop = levels.find((level) => level.kind === LevelKind.STOP_LOSS);
    expect(stop?.trailing).toBe(true);
    expect(stop?.draggable).toBe(true);
    expect(stop?.title).toContain('trailing');
    // The distance, not just the fact of it: the level alone does not say how
    // far behind the market the engine will keep the stop.
    expect(stop?.title).toContain('5.00');
  });
});

describe('outcomeAt', () => {
  /**
   * The reference figure: one lot of gold, contract size 100, entered at
   * 4583.72 and stopped at 4580.00. 3.72 × 100 = 372.00 against a long.
   */
  it('estimates what a stop would cost, using the engine formula', () => {
    expect(outcomeAt(position(), XAUUSD, '4580.00', 'USD')).toBe('-372.00');
  });

  it('estimates what a target would make', () => {
    // 4590.00 − 4583.72 = 6.28, times a contract size of 100.
    expect(outcomeAt(position(), XAUUSD, '4590.00', 'USD')).toBe('628.00');
  });

  it('mirrors the sign for a short', () => {
    const short = position({ side: 'SELL', entryPrice: '4583.58' });
    expect(outcomeAt(short, XAUUSD, '4580.00', 'USD')).toBe('358.00');
  });

  /**
   * A dash on screen is honest. A zero would read as "this stop costs you
   * nothing", which is the opposite of true.
   */
  it('returns nothing rather than zero when it cannot be computed', () => {
    expect(outcomeAt(position(), undefined, '4580.00', 'USD')).toBeNull();
    expect(outcomeAt(position(), XAUUSD, 'not-a-price', 'USD')).toBeNull();
  });
});

describe('priceFromDrag', () => {
  /**
   * A pixel is not a price. A cursor lands between ticks, and sending an
   * off-grid level would have the server reject a drag the trader performed
   * exactly as they meant to.
   */
  it('snaps a dropped coordinate to the instrument tick grid', () => {
    /**
     * The instrument here trades in five-cent ticks while quoting two decimals,
     * so the tick grid and the decimal precision disagree — which is the only
     * way this test can tell snapping from `toFixed`. Gold, whose tick *is* one
     * cent, cannot distinguish them, and a version of this test written against
     * gold passed with the snapping removed entirely.
     */
    const coarse: SymbolRow = { ...XAUUSD, tickSize: '0.05' };
    const outcome = priceFromDrag(coarse, position(), LevelKind.STOP_LOSS, 4580.0074, '4583.58');
    expect(outcome.price).toBe('4580.00');
    expect(priceFromDrag(coarse, position(), LevelKind.STOP_LOSS, 4580.033, '4583.58').price).toBe(
      '4580.05',
    );
    expect(outcome.error).toBeNull();
  });

  /**
   * The server's own rule, imported rather than reimplemented, so the browser
   * cannot invent a restriction the engine does not have or miss one it does.
   */
  it("refuses a long's stop dropped above the market", () => {
    const outcome = priceFromDrag(XAUUSD, position(), LevelKind.STOP_LOSS, 4600.0, '4583.58');
    expect(outcome.error).not.toBeNull();
  });

  it("refuses a long's target dropped below the market", () => {
    const outcome = priceFromDrag(XAUUSD, position(), LevelKind.TAKE_PROFIT, 4500.0, '4583.58');
    expect(outcome.error).not.toBeNull();
  });

  it('mirrors both rules for a short', () => {
    const short = position({ side: 'SELL' });
    expect(
      priceFromDrag(XAUUSD, short, LevelKind.STOP_LOSS, 4500.0, '4583.72').error,
    ).not.toBeNull();
    expect(
      priceFromDrag(XAUUSD, short, LevelKind.TAKE_PROFIT, 4600.0, '4583.72').error,
    ).not.toBeNull();
    expect(priceFromDrag(XAUUSD, short, LevelKind.STOP_LOSS, 4600.0, '4583.72').error).toBeNull();
  });

  /**
   * With no quote there is nothing to validate against, and the server is the
   * right authority anyway. Refusing here would block a legitimate drag on a
   * chart whose feed had briefly gone quiet.
   */
  it('sends the level anyway when there is no quote to check it against', () => {
    const outcome = priceFromDrag(XAUUSD, position(), LevelKind.STOP_LOSS, 4600.0, null);
    expect(outcome.price).toBe('4600.00');
    expect(outcome.error).toBeNull();
  });

  it('refuses a coordinate that is not a price at all', () => {
    expect(
      priceFromDrag(XAUUSD, position(), LevelKind.STOP_LOSS, -1, '4583.58').error,
    ).not.toBeNull();
    expect(
      priceFromDrag(XAUUSD, position(), LevelKind.STOP_LOSS, Number.NaN, '4583.58').error,
    ).not.toBeNull();
  });
});

describe('modificationFor', () => {
  /**
   * `null` is how the API spells "remove this level". Sending it for the level
   * the trader did not touch would clear their take-profit every time they
   * nudged a stop — a silent, expensive bug.
   */
  it('names only the level that moved', () => {
    expect(modificationFor(LevelKind.STOP_LOSS, '4581.00')).toEqual({ stopLoss: '4581.00' });
    expect(modificationFor(LevelKind.TAKE_PROFIT, '4595.00')).toEqual({ takeProfit: '4595.00' });
  });

  it('never sends null for the untouched level', () => {
    for (const kind of [LevelKind.STOP_LOSS, LevelKind.TAKE_PROFIT]) {
      const body = modificationFor(kind, '4581.00') as Record<string, unknown>;
      expect(Object.values(body)).not.toContain(null);
      expect(Object.keys(body)).toHaveLength(1);
    }
  });
});

// ─── Resting orders on the chart ───────────────────────────────────────────

function pending(overrides: Partial<PendingOrderRow> = {}): PendingOrderRow {
  return {
    orderId: 'o1',
    status: 'PENDING',
    symbol: 'XAUUSD',
    side: 'BUY',
    type: 'LIMIT',
    volume: '1',
    price: '4570.00',
    stopLoss: null,
    takeProfit: null,
    timeInForce: 'GTC',
    expiresAt: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    ...overrides,
  };
}

const QUOTE = { bid: '4583.58', ask: '4583.72' };

describe('pendingLevelsFor', () => {
  it('draws one line per resting order on this instrument', () => {
    const levels = pendingLevelsFor([pending()], 'XAUUSD', XAUUSD, QUOTE);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.kind).toBe(LevelKind.PENDING);
    expect(levels[0]?.orderId).toBe('o1');
    expect(levels[0]?.positionId).toBeNull();
    expect(levels[0]?.draggable).toBe(true);
  });

  it('leaves another instrument alone', () => {
    expect(pendingLevelsFor([pending({ symbol: 'EURUSD' })], 'XAUUSD', XAUUSD, QUOTE)).toEqual([]);
  });

  it('names the side, the type and how far away it is', () => {
    // A buy is measured against the ask: 4583.72 - 4570.00 = 13.72 = 1372 points.
    const levels = pendingLevelsFor([pending()], 'XAUUSD', XAUUSD, QUOTE);
    expect(levels[0]?.title).toBe('BUY LIMIT 1  1372 pt');
  });

  /**
   * A distance of zero would read as "about to trigger". Silence is the honest
   * answer when there is no quote to measure against.
   */
  it('omits the distance rather than showing zero when no quote has arrived', () => {
    const levels = pendingLevelsFor([pending()], 'XAUUSD', XAUUSD, undefined);
    expect(levels[0]?.title).toBe('BUY LIMIT 1');
  });
});

describe('priceFromPendingDrag', () => {
  it('snaps the dropped price to the instrument tick grid', () => {
    const moved = priceFromPendingDrag(XAUUSD, pending(), 4571.4837, QUOTE);
    expect(moved.error).toBeNull();
    expect(moved.price).toBe('4571.48');
  });

  /**
   * The mistake that matters. A buy limit dragged above the ask is not a
   * resting order — it fires on the next tick at a price the trader never saw.
   * The rule comes from `@tp/trading-core`, the same module the server runs.
   */
  it('refuses a drag that would fire the order immediately', () => {
    const moved = priceFromPendingDrag(XAUUSD, pending(), 4590, QUOTE);
    expect(moved.error).not.toBeNull();
    expect(moved.error).toContain('fill immediately');
  });

  it('refuses the same mistake in the other direction, for a sell limit', () => {
    const order = pending({ side: 'SELL', type: 'LIMIT', price: '4600.00' });
    expect(priceFromPendingDrag(XAUUSD, order, 4570, QUOTE).error).not.toBeNull();
    expect(priceFromPendingDrag(XAUUSD, order, 4610, QUOTE).error).toBeNull();
  });

  it('lets a buy stop rest above the market and refuses it below', () => {
    const order = pending({ side: 'BUY', type: 'STOP', price: '4600.00' });
    expect(priceFromPendingDrag(XAUUSD, order, 4610, QUOTE).error).toBeNull();
    expect(priceFromPendingDrag(XAUUSD, order, 4570, QUOTE).error).not.toBeNull();
  });

  it('sends the snapped price and lets the server decide when there is no quote', () => {
    const moved = priceFromPendingDrag(XAUUSD, pending(), 4590, undefined);
    expect(moved.error).toBeNull();
    expect(moved.price).toBe('4590.00');
  });

  it('refuses a coordinate that is not a price at all', () => {
    expect(priceFromPendingDrag(XAUUSD, pending(), Number.NaN, QUOTE).error).not.toBeNull();
    expect(priceFromPendingDrag(XAUUSD, pending(), -1, QUOTE).error).not.toBeNull();
  });

  it('refuses to drag an order type that does not rest on a price', () => {
    const moved = priceFromPendingDrag(XAUUSD, pending({ type: 'MARKET' }), 4570, QUOTE);
    expect(moved.error).toContain('cannot be dragged');
  });
});

describe('levelIdentity', () => {
  it('distinguishes a position level from an order level', () => {
    const [entry] = levelsFor([position()], 'XAUUSD');
    const [order] = pendingLevelsFor([pending()], 'XAUUSD', XAUUSD, QUOTE);
    expect(levelIdentity(entry!)).toBe('p1:ENTRY');
    expect(levelIdentity(order!)).toBe('o1:PENDING');
  });
});
