import { Decimal, Money, grossPnl, toDecimal, type SymbolSpec } from '@tp/financial-core';

/**
 * The one calculator for a protective level.
 *
 * ## Why this exists
 *
 * A stop loss can be expressed four ways — a price, a distance from entry, a
 * number of points, or the money it would cost — and a trader moves between
 * them freely. Until this file, the arithmetic that connects them lived in
 * three separate places in the web app (`lib/ticket.ts`, `lib/chart-levels.ts`,
 * `lib/points.ts`) and nowhere the mobile app could reach, so the phone had a
 * fourth copy of its own.
 *
 * Four implementations of "what will this stop cost me" is four chances to
 * disagree, and the disagreement is only visible to the person who set a stop
 * on the chart and read a different number in the ticket. So there is one here
 * now, framework-free, with the platform's own decimal arithmetic, and the
 * screens convert to strings at their edges.
 *
 * ## What it does not do
 *
 * It does not decide anything. Whether a level is *allowed* is
 * `validateProtectiveLevels`, and whether one has *fired* is
 * `evaluateProtectiveTrigger` — both already in this package, both used by the
 * server. This is the arithmetic a person needs to see while choosing a level,
 * and the server never consults it.
 *
 * It also does not invent an exchange rate. Every figure that crosses
 * currencies takes `quoteToAccountRate` from the caller; a browser that does
 * not hold one passes nothing and gets `null`, because a wrong number here is
 * worse than no number.
 */

/** How far a level sits from a reference, in the units a trader speaks in. */
export interface LevelDistance {
  /** Absolute price difference, as a decimal string. */
  readonly price: string;
  /**
   * The same distance in points — one unit of the instrument's last displayed
   * decimal. `0.00001` on a five-decimal pair, `0.01` on gold. It is the only
   * unit in which "twelve away" means the same thing on EURUSD and XAUUSD.
   */
  readonly points: number;
}

/**
 * The distance between two prices, or `null` when either is not a number.
 *
 * Unsigned. Which side of the entry a level sits on is a fact about the level's
 * kind and the position's side, not about the distance, and signing it here
 * would make callers strip the sign back off.
 */
export function distanceBetween(
  from: string,
  to: string,
  priceDecimals: number,
): LevelDistance | null {
  if (!isDecimal(from) || !isDecimal(to)) return null;
  if (!Number.isInteger(priceDecimals) || priceDecimals < 0 || priceDecimals > 12) return null;

  const difference = toDecimal(to).minus(toDecimal(from)).abs();
  const points = difference.mul(new Decimal(10).pow(priceDecimals));
  if (!points.isFinite()) return null;
  return { price: difference.toString(), points: Number(points.toDecimalPlaces(0).toString()) };
}

/**
 * The price a given distance from `from`, on the side a level of this kind
 * would sit for this position.
 *
 * A stop is always adverse and a target always favourable, so the direction is
 * derived rather than asked for: a caller that had to work it out would be a
 * caller that could get it wrong, and a "stop" placed on the profitable side is
 * an order that never protects anything.
 */
export function priceAtDistance(
  from: string,
  distance: string,
  side: 'BUY' | 'SELL',
  kind: 'STOP_LOSS' | 'TAKE_PROFIT',
): string | null {
  if (!isDecimal(from) || !isDecimal(distance)) return null;
  const adverse = kind === 'STOP_LOSS';
  // A long loses when price falls; a short loses when it rises.
  const down = adverse === (side === 'BUY');
  const move = toDecimal(distance).abs();
  return (down ? toDecimal(from).minus(move) : toDecimal(from).plus(move)).toString();
}

/** The price a given number of points away, in the same direction. */
export function priceAtPoints(
  from: string,
  points: number,
  priceDecimals: number,
  side: 'BUY' | 'SELL',
  kind: 'STOP_LOSS' | 'TAKE_PROFIT',
): string | null {
  if (!Number.isFinite(points) || !Number.isInteger(priceDecimals)) return null;
  const distance = new Decimal(points).abs().div(new Decimal(10).pow(priceDecimals));
  return priceAtDistance(from, distance.toString(), side, kind);
}

export interface OutcomeInput {
  readonly spec: SymbolSpec;
  readonly side: 'BUY' | 'SELL';
  readonly volume: string;
  readonly entryPrice: string;
  readonly exitPrice: string;
  readonly accountCurrency: string;
  /**
   * Quote currency into account currency. `null` when the caller has no rate —
   * which returns `null` rather than assuming 1, because assuming 1 on a
   * cross-currency instrument is how a screen shows a confident wrong number.
   */
  readonly quoteToAccountRate: string | null;
}

/**
 * What a position would be worth if it closed at `exitPrice`.
 *
 * Gross: commission is its own line and swap depends on how long the position
 * is held, which nobody knows at the moment of entry. Both are shown
 * separately by the screens that show this.
 */
export function outcomeAt(input: OutcomeInput): string | null {
  if (input.quoteToAccountRate === null) return null;
  if (!isDecimal(input.volume) || !isDecimal(input.entryPrice) || !isDecimal(input.exitPrice)) {
    return null;
  }
  try {
    return grossPnl({
      spec: input.spec,
      side: input.side,
      volume: input.volume,
      entryPrice: input.entryPrice,
      exitPrice: input.exitPrice,
      accountCurrency: input.accountCurrency as SymbolSpec['quoteCurrency'],
      quoteToAccountRate: input.quoteToAccountRate,
    }).toString();
  } catch {
    // A half-typed level is the normal state of an input being filled in.
    return null;
  }
}

/**
 * Reward divided by risk, as a plain ratio.
 *
 * `null` unless both projections exist and the risk side really is a loss. A
 * "risk" that is positive means the stop sits on the profitable side of the
 * entry, and dividing by it would print a confident, meaningless number over
 * a mistake the trader most needs to notice.
 */
export function rewardToRisk(profit: string | null, loss: string | null): string | null {
  if (profit === null || loss === null) return null;
  if (!isDecimal(profit) || !isDecimal(loss)) return null;
  const reward = toDecimal(profit);
  const risk = toDecimal(loss);
  if (!risk.lessThan(0) || !reward.greaterThan(0)) return null;
  return reward.div(risk.abs()).toDecimalPlaces(2).toString();
}

/**
 * A money figure as a percentage of equity, to one decimal place.
 *
 * The number a trader actually manages by: "two percent" is a rule people
 * follow, and "eighty-four dollars" is not. Unsigned, because it is always
 * shown beside a label that already says whether it is risk or reward.
 *
 * `null` on zero or negative equity — an account with nothing in it has no
 * meaningful percentage, and dividing by it would produce Infinity on the one
 * screen where a trader is deciding how much to lose.
 */
export function percentOfEquity(amount: string | null, equity: string): string | null {
  if (amount === null || !isDecimal(amount) || !isDecimal(equity)) return null;
  const total = toDecimal(equity);
  if (!total.greaterThan(0)) return null;
  return toDecimal(amount).abs().div(total).mul(100).toDecimalPlaces(1).toString();
}

/**
 * Everything a screen shows about one protective level, from a price.
 *
 * Assembled in one call so that the ticket, the position editor, the chart's
 * drag handler and the phone all read the same four numbers from the same
 * arithmetic rather than each computing the subset it happens to display.
 */
export interface LevelView {
  readonly price: string;
  readonly distance: LevelDistance | null;
  /** Gross money if the position closed here. Null without a rate. */
  readonly outcome: string | null;
  /** That money as a percentage of equity. Null without equity or a rate. */
  readonly percentOfEquity: string | null;
}

export function levelView(input: {
  readonly spec: SymbolSpec;
  readonly side: 'BUY' | 'SELL';
  readonly volume: string;
  readonly entryPrice: string;
  readonly levelPrice: string;
  readonly accountCurrency: string;
  readonly quoteToAccountRate: string | null;
  readonly equity: string | null;
}): LevelView | null {
  if (!isDecimal(input.levelPrice)) return null;
  const outcome = outcomeAt({
    spec: input.spec,
    side: input.side,
    volume: input.volume,
    entryPrice: input.entryPrice,
    exitPrice: input.levelPrice,
    accountCurrency: input.accountCurrency,
    quoteToAccountRate: input.quoteToAccountRate,
  });
  return {
    price: input.levelPrice,
    distance: distanceBetween(input.entryPrice, input.levelPrice, input.spec.pricePrecision),
    outcome,
    percentOfEquity: input.equity === null ? null : percentOfEquity(outcome, input.equity),
  };
}

/**
 * The volume that risks exactly `amount` if price reaches `stopPrice`.
 *
 * Position sizing, backwards from the loss a trader is willing to take — the
 * calculation people otherwise do on a phone calculator and get wrong. Rounded
 * **down** to the instrument's volume step, never up: a size that rounds up
 * risks more than was asked for, and the whole point of the number is the
 * ceiling on the loss.
 *
 * `null` when the stop is not adverse to the side, when the step would make it
 * zero, or when there is no rate — each of which is a question this cannot
 * answer rather than one to guess at.
 */
export function volumeForRisk(input: {
  readonly spec: SymbolSpec;
  readonly side: 'BUY' | 'SELL';
  readonly entryPrice: string;
  readonly stopPrice: string;
  readonly riskAmount: string;
  readonly accountCurrency: string;
  readonly quoteToAccountRate: string | null;
}): string | null {
  if (input.quoteToAccountRate === null) return null;
  if (!isDecimal(input.entryPrice) || !isDecimal(input.stopPrice) || !isDecimal(input.riskAmount)) {
    return null;
  }
  const risk = toDecimal(input.riskAmount).abs();
  if (!risk.greaterThan(0)) return null;

  // Loss per lot at that stop, using the same arithmetic the outcome uses.
  const perLot = outcomeAt({
    spec: input.spec,
    side: input.side,
    volume: '1',
    entryPrice: input.entryPrice,
    exitPrice: input.stopPrice,
    accountCurrency: input.accountCurrency,
    quoteToAccountRate: input.quoteToAccountRate,
  });
  if (perLot === null) return null;
  const loss = toDecimal(perLot);
  // A stop on the profitable side is not a stop; sizing from it is meaningless.
  if (!loss.lessThan(0)) return null;

  const raw = risk.div(loss.abs());
  const step = toDecimal(input.spec.volumeStep);
  if (!step.greaterThan(0)) return null;
  const stepped = raw.div(step).floor().mul(step);
  if (!stepped.greaterThan(0)) return null;
  if (stepped.lessThan(toDecimal(input.spec.minVolume))) return null;
  const capped = stepped.greaterThan(toDecimal(input.spec.maxVolume))
    ? toDecimal(input.spec.maxVolume)
    : stepped;
  return capped.toString();
}

/** Money in the account's currency, for a screen that wants one formatted. */
export function asMoney(amount: string, currency: string): Money {
  return Money.of(amount, currency as SymbolSpec['quoteCurrency']);
}

function isDecimal(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return /^-?\d+(\.\d+)?$/.test(trimmed);
}
