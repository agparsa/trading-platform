import { toDecimal, type SymbolSpec } from '@tp/financial-core';
import {
  levelView,
  priceAtDistance,
  priceAtPoints,
  priceForOutcome,
  type LevelView,
} from '@tp/trading-core';
import type { SymbolRow } from './queries';

/**
 * A protective level, entered the way the trader thinks about it.
 *
 * A stop can be a price, a distance from the entry, a number of points, the
 * money it would cost, or that money as a share of equity. The API takes a
 * price and nothing else — a level is an order, and an order has a price — so
 * every other way of saying it is turned into one here, with the calculator in
 * `@tp/trading-core` that the ticket and the chart already read from. The
 * editor keeps what the trader typed and the unit they typed it in; what it
 * sends is the price this resolves to.
 *
 * Nothing here is consulted by the server. `validateProtectiveLevels` decides
 * whether the resulting price is allowed, on the server, on every request.
 */
export type LevelMode = 'price' | 'distance' | 'points' | 'money' | 'percent';

export const LEVEL_MODES: ReadonlyArray<{ readonly mode: LevelMode; readonly label: string }> = [
  { mode: 'price', label: 'Price' },
  { mode: 'distance', label: 'Distance' },
  { mode: 'points', label: 'Points' },
  { mode: 'money', label: 'Money' },
  { mode: 'percent', label: '% equity' },
];

export interface LevelContext {
  readonly spec: SymbolRow;
  readonly side: 'BUY' | 'SELL';
  readonly kind: 'STOP_LOSS' | 'TAKE_PROFIT';
  readonly volume: string;
  readonly entryPrice: string;
  readonly accountCurrency: string;
  /** Account equity, for the percent mode; `null` when the screen has none yet. */
  readonly equity: string | null;
}

function isDecimal(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * The browser holds no exchange rate. Same currency means one; anything else
 * means the money modes answer nothing rather than a guessed figure.
 */
function rateFor(context: LevelContext): string | null {
  return context.spec.quoteCurrency === context.accountCurrency ? '1' : null;
}

/**
 * The price a typed value resolves to in a mode, or `null` while it cannot:
 * empty, half-typed, or a unit the screen cannot convert (money on an
 * instrument quoted in a currency the account does not hold).
 *
 * Every mode but `price` rounds to the instrument's displayed decimals, since
 * that is what an order can carry; `price` is sent as typed, and the server
 * says if it is off the tick.
 */
export function priceFromEntry(
  mode: LevelMode,
  text: string,
  context: LevelContext,
): string | null {
  const value = text.trim();
  if (value === '') return null;
  const spec = context.spec as SymbolSpec;
  switch (mode) {
    case 'price':
      return isDecimal(value) && Number(value) > 0 ? value : null;
    case 'distance': {
      if (!isDecimal(value)) return null;
      const price = priceAtDistance(context.entryPrice, value, context.side, context.kind);
      return roundedPrice(price, spec.pricePrecision);
    }
    case 'points': {
      if (!/^-?\d+$/.test(value)) return null;
      const price = priceAtPoints(
        context.entryPrice,
        Number(value),
        spec.pricePrecision,
        context.side,
        context.kind,
      );
      return roundedPrice(price, spec.pricePrecision);
    }
    case 'money':
      if (!isDecimal(value)) return null;
      return priceForOutcome({
        spec,
        side: context.side,
        volume: context.volume,
        entryPrice: context.entryPrice,
        amount: value,
        accountCurrency: context.accountCurrency,
        quoteToAccountRate: rateFor(context),
        kind: context.kind,
      });
    case 'percent': {
      if (!isDecimal(value) || context.equity === null || !isDecimal(context.equity)) return null;
      const equity = toDecimal(context.equity);
      if (!equity.greaterThan(0)) return null;
      // Percent of equity to money, at the precision money has; the calculator
      // takes it from there. Decimal throughout — this is money.
      const amount = equity.mul(toDecimal(value).abs()).div(100).toFixed(2);
      return priceForOutcome({
        spec,
        side: context.side,
        volume: context.volume,
        entryPrice: context.entryPrice,
        amount,
        accountCurrency: context.accountCurrency,
        quoteToAccountRate: rateFor(context),
        kind: context.kind,
      });
    }
  }
}

function roundedPrice(price: string | null, decimals: number): string | null {
  if (price === null) return null;
  const exact = toDecimal(price);
  if (!exact.isFinite() || !exact.greaterThan(0)) return null;
  return exact.toFixed(decimals);
}

/**
 * Everything the editor shows beside a resolved price: how far it is, in
 * price and points, what it would cost or make, and that as a share of equity.
 * `null` when there is no price to describe.
 */
export function describeLevel(price: string | null, context: LevelContext): LevelView | null {
  if (price === null) return null;
  return levelView({
    spec: context.spec as SymbolSpec,
    side: context.side,
    volume: context.volume,
    entryPrice: context.entryPrice,
    levelPrice: price,
    accountCurrency: context.accountCurrency,
    quoteToAccountRate: rateFor(context),
    equity: context.equity,
  });
}
