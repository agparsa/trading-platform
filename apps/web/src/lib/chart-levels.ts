import { grossPnl, normalizePrice, toDecimal, type SymbolSpec } from '@tp/financial-core';
import { DomainError } from '@tp/shared-types';
import { validatePendingPrice, validateProtectiveLevels } from '@tp/trading-core';
import { distanceInPoints } from './points';
import type { PendingOrderRow, PositionRow, SymbolRow } from './queries';

/**
 * What the chart draws on top of the price, and the rules for moving it.
 *
 * Kept out of the component for the same reason the order ticket is: these are
 * decisions about a trader's money — where a stop may legally sit, what a move
 * would cost — and they are worth testing directly rather than through a
 * rendering snapshot.
 *
 * The rule the whole module exists to hold: **a drawn level is always the
 * server's value.** Dragging produces a *preview*, which is a different thing
 * with a different appearance, and the preview disappears when the server
 * answers. The authoritative line is never moved by the browser, so a rejected
 * modification needs no "revert" — there was nothing to revert.
 */

export const LevelKind = {
  ENTRY: 'ENTRY',
  STOP_LOSS: 'STOP_LOSS',
  TAKE_PROFIT: 'TAKE_PROFIT',
  /** A resting order's own trigger price. */
  PENDING: 'PENDING',
} as const;
export type LevelKind = (typeof LevelKind)[keyof typeof LevelKind];

export interface ChartLevel {
  /** Set when this line belongs to an open position. */
  positionId: string | null;
  /** Set when this line belongs to a resting order. Exactly one of the two is set. */
  orderId: string | null;
  kind: LevelKind;
  /** Decimal string, exactly as the server stated it. */
  price: string;
  /** `null` for the entry line, which is not draggable. */
  draggable: boolean;
  /** Set on a stop that the trailing engine is moving. */
  trailing: boolean;
  title: string;
}

/** Stable identity for one drawn line. */
export function levelIdentity(level: ChartLevel): string {
  return `${level.positionId ?? level.orderId ?? '?'}:${level.kind}`;
}

/**
 * The levels to draw for one instrument.
 *
 * Only the charted symbol's open positions: a stop belonging to a position in
 * gold means nothing drawn across a chart of the euro, and drawing it would
 * invite somebody to drag it.
 */
export function levelsFor(
  positions: readonly PositionRow[],
  symbolCode: string | undefined,
): ChartLevel[] {
  if (symbolCode === undefined) return [];
  const levels: ChartLevel[] = [];

  for (const position of positions) {
    if (position.symbol !== symbolCode) continue;
    if (position.status !== 'OPEN' && position.status !== 'CLOSING') continue;

    levels.push({
      positionId: position.id,
      orderId: null,
      kind: LevelKind.ENTRY,
      price: position.entryPrice,
      draggable: false,
      trailing: false,
      title: `${position.side} ${position.volume}`,
    });

    const trailing = position.trailingStopDistance !== null;
    if (position.stopLoss !== null) {
      levels.push({
        positionId: position.id,
        orderId: null,
        kind: LevelKind.STOP_LOSS,
        price: position.stopLoss,
        // A trailing stop is still draggable: the trader may tighten it by hand
        // and the engine will carry on from wherever they leave it. Refusing the
        // drag would make the safer stop the harder one to set.
        draggable: true,
        trailing,
        // A trailing stop names its distance: the current level alone does not
        // say how far behind the market the engine will keep it, which is the
        // one thing a trader needs to know to judge whether it is protecting
        // anything.
        title: trailing
          ? `SL ${position.stopLoss} · trailing ${position.trailingStopDistance ?? ''}`.trim()
          : `SL ${position.stopLoss}`,
      });
    }
    if (position.takeProfit !== null) {
      levels.push({
        positionId: position.id,
        orderId: null,
        kind: LevelKind.TAKE_PROFIT,
        price: position.takeProfit,
        draggable: true,
        trailing: false,
        title: `TP ${position.takeProfit}`,
      });
    }
  }
  return levels;
}

/**
 * What this level would be worth if price reached it, right now.
 *
 * An **estimate**, and it must never be presented as anything else. It runs the
 * engine's own `grossPnl` so the browser cannot invent an arithmetic the server
 * does not have, but three things it cannot know make it a projection rather
 * than a result: the fill will happen at some future quote, the closing
 * commission has not been charged, and swap keeps accruing until the position
 * closes.
 *
 * Returns `null` rather than a number when the inputs are not there. A dash on
 * screen is honest; a zero would read as "this stop costs you nothing".
 */
export function outcomeAt(
  position: PositionRow,
  spec: SymbolRow | undefined,
  price: string,
  accountCurrency: string,
  quoteToAccountRate = '1',
): string | null {
  if (spec === undefined) return null;
  try {
    return grossPnl({
      spec: spec as SymbolSpec,
      side: position.side,
      volume: position.volume,
      entryPrice: position.entryPrice,
      exitPrice: price,
      accountCurrency,
      quoteToAccountRate,
    }).toString();
  } catch {
    // A malformed price from a half-finished drag is not worth an error banner.
    return null;
  }
}

export interface DragOutcome {
  /** The price to send, snapped to the instrument's tick grid. */
  price: string;
  /** Set when the level cannot legally sit there; the drag is refused. */
  error: string | null;
}

/**
 * Turns a dropped chart coordinate into a price the server would accept.
 *
 * Two steps, both of which have to happen here rather than on the server alone.
 *
 * **Snapping.** A pixel is not a price. A cursor lands between ticks, and
 * sending an off-grid level would have the server reject a drag the trader
 * performed exactly as intended. `normalizePrice` is the same quantiser the
 * engine uses.
 *
 * **Validating.** `validateProtectiveLevels` is the server's own rule, imported
 * rather than reimplemented, so the browser can answer "a stop cannot sit above
 * the market on a long" in the same gesture instead of a round trip. The server
 * still validates; this only decides whether the request is worth sending.
 */
export function priceFromDrag(
  spec: SymbolRow | undefined,
  position: PositionRow,
  kind: LevelKind,
  rawPrice: number,
  reference: string | null,
): DragOutcome {
  if (spec === undefined) return { price: '', error: 'No instrument.' };
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    return { price: '', error: 'That is not a price.' };
  }

  const snapped = normalizePrice(spec as SymbolSpec, toDecimal(rawPrice.toFixed(10))).toFixed(
    spec.pricePrecision,
  );

  // Without a live quote there is nothing to validate against. Sending it lets
  // the server decide, which is the right authority anyway.
  if (reference === null) return { price: snapped, error: null };

  try {
    validateProtectiveLevels(spec as SymbolSpec, position.side, reference, {
      stopLoss: kind === LevelKind.STOP_LOSS ? snapped : null,
      takeProfit: kind === LevelKind.TAKE_PROFIT ? snapped : null,
    });
    return { price: snapped, error: null };
  } catch (error) {
    return {
      price: snapped,
      error: error instanceof DomainError ? error.message : 'That level is not allowed.',
    };
  }
}

/**
 * The body of a `PATCH /positions/:id` that moves one level and nothing else.
 *
 * `undefined` for the untouched level rather than `null`: `null` is how the API
 * spells "remove this", so sending it for the level the trader did not touch
 * would clear a take-profit every time they moved a stop.
 */
export function modificationFor(
  kind: LevelKind,
  price: string,
): { stopLoss?: string; takeProfit?: string } {
  return kind === LevelKind.STOP_LOSS ? { stopLoss: price } : { takeProfit: price };
}

/**
 * Lines for the resting orders on this instrument.
 *
 * A pending order is a different kind of line from a stop or a target: it is not
 * protecting an open position, it is an instruction waiting to *create* one. So
 * it is drawn in its own colour and labelled with its side and type — a trader
 * looking at three dashed lines needs to know at a glance which of them will
 * open a trade and which will close one.
 *
 * The distance to the market is part of the label because it is the question the
 * line exists to answer. It is measured against the side the order would
 * actually fire on, and omitted entirely when there is no quote — a distance of
 * "0" from a missing price would read as "about to trigger".
 */
export function pendingLevelsFor(
  orders: readonly PendingOrderRow[],
  symbolCode: string | undefined,
  spec: SymbolRow | undefined,
  quote: { bid: string; ask: string } | undefined,
): ChartLevel[] {
  if (symbolCode === undefined) return [];
  const levels: ChartLevel[] = [];

  for (const order of orders) {
    if (order.symbol !== symbolCode) continue;

    const reference = quote === undefined ? null : order.side === 'BUY' ? quote.ask : quote.bid;
    const away = distanceInPoints(order.price, reference, spec?.pricePrecision ?? 2);
    const suffix = away === null ? '' : `  ${away} pt`;

    levels.push({
      positionId: null,
      orderId: order.orderId,
      kind: LevelKind.PENDING,
      price: order.price,
      draggable: true,
      trailing: false,
      title: `${order.side} ${order.type} ${order.volume}${suffix}`,
    });
  }

  return levels;
}

/**
 * Where a dragged resting order may be dropped.
 *
 * Same two steps as a protective level — snap to the tick grid, then run the
 * server's own rule — but the rule is a different one. `validatePendingPrice`
 * refuses a price that would fire the order immediately, which is the mistake
 * that matters here: an order dragged past the market is not a resting order at
 * all, it is a market order the trader did not ask for, executing on the next
 * tick at a price they never saw.
 *
 * Only `LIMIT` and `STOP` rest. Anything else is refused rather than guessed at.
 */
export function priceFromPendingDrag(
  spec: SymbolRow | undefined,
  order: PendingOrderRow,
  rawPrice: number,
  quote: { bid: string; ask: string } | undefined,
): DragOutcome {
  if (spec === undefined) return { price: '', error: 'No instrument.' };
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    return { price: '', error: 'That is not a price.' };
  }
  if (order.type !== 'LIMIT' && order.type !== 'STOP') {
    return { price: '', error: `A ${order.type} order cannot be dragged.` };
  }

  const snapped = normalizePrice(spec as SymbolSpec, toDecimal(rawPrice.toFixed(10))).toFixed(
    spec.pricePrecision,
  );

  // No quote means nothing to measure against. The server has one and will
  // refuse the move if it is wrong, which is the right authority anyway.
  if (quote === undefined) return { price: snapped, error: null };

  try {
    validatePendingPrice(spec as SymbolSpec, order.type, order.side, snapped, quote);
    return { price: snapped, error: null };
  } catch (error) {
    return {
      price: snapped,
      error: error instanceof DomainError ? error.message : 'That price is not allowed.',
    };
  }
}
