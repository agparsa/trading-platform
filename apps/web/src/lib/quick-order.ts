import { toDecimal } from '@tp/financial-core';
import { priceFromEntry } from './level-entry';
import type { AccountSummary, SymbolRow } from './queries';
import { projectedOutcome, sizeForRisk, validateTicket } from './ticket';

/**
 * What the chart's quick-trade box asks for, beyond the lots: a stop and a
 * target as a distance in points from the price the order opens at, and —
 * optionally — the lots sized so the stop costs a share of equity.
 *
 * Points rather than prices because the box sends at market: the trader does
 * not know the fill price when they press, and "300 points behind" means the
 * same thing at whatever price it fills, on either side. The server receives
 * prices — the only thing a level is — and checks them as it checks every
 * level (`validateProtectiveLevels`); nothing here is consulted by it.
 */
export interface QuickOrderInput {
  readonly spec: SymbolRow;
  readonly account: AccountSummary | undefined;
  readonly equity: string | null | undefined;
  readonly side: 'BUY' | 'SELL';
  /** The executable price for this side: the ask to buy, the bid to sell. */
  readonly entry: string | null;
  /** The lots typed; replaced by the sized lots when `riskPercent` is set. */
  readonly volume: string;
  /** Whole points; empty for none. */
  readonly stopPoints: string;
  readonly takePoints: string;
  /** Percent of equity the stop may cost; empty for "use the lots typed". */
  readonly riskPercent: string;
}

export interface QuickOrder {
  readonly volume: string;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  /** What the stop and the target would come to, signed, in account money. */
  readonly ifStopped: string | null;
  readonly ifTargeted: string | null;
  /** Why this cannot be sent, or `null`. */
  readonly error: string | null;
}

export type QuickOrderProblem =
  'noPrice' | 'stopPoints' | 'takePoints' | 'riskNeedsStop' | 'riskPercent' | 'riskTooSmall';

export function resolveQuickOrder(
  input: QuickOrderInput,
  words: Readonly<Record<QuickOrderProblem, string>>,
): QuickOrder {
  const fail = (error: string, volume = input.volume.trim()): QuickOrder => ({
    volume,
    stopLoss: null,
    takeProfit: null,
    ifStopped: null,
    ifTargeted: null,
    error,
  });
  const { spec, side, entry } = input;
  if (entry === null) return fail(words.noPrice);

  const stopText = input.stopPoints.trim();
  const takeText = input.takePoints.trim();
  const riskText = input.riskPercent.trim();
  if (stopText !== '' && !isWholePositive(stopText)) return fail(words.stopPoints);
  if (takeText !== '' && !isWholePositive(takeText)) return fail(words.takePoints);

  const context = (kind: 'STOP_LOSS' | 'TAKE_PROFIT', volume: string) => ({
    spec,
    side,
    kind,
    volume,
    entryPrice: entry,
    accountCurrency: input.account?.currency ?? spec.quoteCurrency,
    equity: input.equity ?? null,
  });

  // A distance in points does not depend on the lots, so the stop's price is
  // known before the size is — which is what lets the size follow from it.
  const stopLoss =
    stopText === '' ? null : priceFromEntry('points', stopText, context('STOP_LOSS', '1'));
  if (stopText !== '' && stopLoss === null) return fail(words.stopPoints);

  let volume = input.volume.trim();
  if (riskText !== '') {
    if (stopLoss === null) return fail(words.riskNeedsStop);
    if (!isPositiveDecimal(riskText) || toDecimal(riskText).gt(100)) return fail(words.riskPercent);
    const equity = input.equity;
    if (equity == null || !isPositiveDecimal(equity)) return fail(words.riskTooSmall);
    // Percent of equity to money at money's precision — Decimal throughout.
    const amount = toDecimal(equity).mul(toDecimal(riskText)).div(100).toFixed(2);
    const sized = sizeForRisk(spec, input.account, side, entry, stopLoss, amount);
    if (sized === null || !toDecimal(sized).gte(toDecimal(spec.minVolume))) {
      return fail(words.riskTooSmall);
    }
    volume = sized;
  }

  const takeProfit =
    takeText === '' ? null : priceFromEntry('points', takeText, context('TAKE_PROFIT', volume));
  if (takeText !== '' && takeProfit === null) return fail(words.takePoints, volume);

  const checked = validateTicket(spec, side, volume, stopLoss ?? '', takeProfit ?? '', entry);
  return {
    volume,
    stopLoss,
    takeProfit,
    ifStopped:
      stopLoss === null
        ? null
        : projectedOutcome(spec, input.account, side, volume, entry, stopLoss),
    ifTargeted:
      takeProfit === null
        ? null
        : projectedOutcome(spec, input.account, side, volume, entry, takeProfit),
    error: checked.error,
  };
}

function isWholePositive(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0;
}

function isPositiveDecimal(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim()) && toDecimal(value).gt(0);
}
