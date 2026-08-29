import {
  checkVolume,
  grossPnl,
  requiredMargin,
  toDecimal,
  type SymbolSpec,
} from '@tp/financial-core';
import { DomainError } from '@tp/shared-types';
import { validatePendingPrice, validateProtectiveLevels } from '@tp/trading-core';
import { money } from './format';
import type { AccountSummary, SymbolRow } from './queries';

/**
 * Order-ticket logic, with no rendering in it.
 *
 * Kept apart from the component so it can be tested directly: these are the
 * rules that decide whether a trader's order is worth sending, and they are
 * worth more than a snapshot test of a form.
 */

export function isDecimalString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim());
}

/** Nudge a volume by one lot step, never below the instrument minimum. */
export function stepVolume(spec: SymbolRow, current: string, direction: 1 | -1): string {
  const base = isDecimalString(current) ? toDecimal(current) : toDecimal(spec.minVolume);
  const next = base.plus(toDecimal(spec.volumeStep).mul(direction));
  const floor = toDecimal(spec.minVolume);
  return (next.lt(floor) ? floor : next).toFixed(spec.volumePrecision);
}

export interface TicketValidation {
  error: string | null;
  volumeOk: boolean;
}

/**
 * Client-side pre-flight.
 *
 * This runs the same `checkVolume` and `validateProtectiveLevels` the API runs,
 * from the same package, so the browser cannot invent a rule the server does not
 * have or miss one it does. It exists to answer the trader in the same keystroke
 * rather than a round trip — the server still validates every order, and its
 * answer is the one that counts.
 */
export function validateTicket(
  spec: SymbolRow | undefined,
  side: 'BUY' | 'SELL',
  volume: string,
  stopLoss: string,
  takeProfit: string,
  executable: string | null,
): TicketValidation {
  if (spec === undefined) return { error: null, volumeOk: false };
  if (!isDecimalString(volume)) {
    return { error: 'Volume must be a decimal number.', volumeOk: false };
  }

  const check = checkVolume(spec as SymbolSpec, volume);
  if (!check.ok) {
    const reasons: Record<string, string> = {
      NOT_POSITIVE: 'Volume must be greater than zero.',
      BELOW_MIN: `Minimum volume for ${spec.code} is ${spec.minVolume} lots.`,
      ABOVE_MAX: `Maximum volume for ${spec.code} is ${spec.maxVolume} lots.`,
      OFF_STEP: `Volume must be a multiple of ${spec.volumeStep}.`,
    };
    return { error: reasons[check.reason ?? ''] ?? 'Invalid volume.', volumeOk: false };
  }

  const sl = stopLoss.trim();
  const tp = takeProfit.trim();
  if (sl !== '' && !isDecimalString(sl)) {
    return { error: 'Stop loss must be a price.', volumeOk: true };
  }
  if (tp !== '' && !isDecimalString(tp)) {
    return { error: 'Take profit must be a price.', volumeOk: true };
  }

  // Without a price to measure against there is nothing to check the levels
  // for; the server will do it at execution.
  if ((sl !== '' || tp !== '') && executable !== null) {
    try {
      validateProtectiveLevels(spec as SymbolSpec, side, executable, {
        stopLoss: sl === '' ? null : sl,
        takeProfit: tp === '' ? null : tp,
      });
    } catch (error) {
      return {
        error: error instanceof DomainError ? error.message : 'Invalid protective levels.',
        volumeOk: true,
      };
    }
  }

  return { error: null, volumeOk: true };
}

/**
 * Estimated margin and commission.
 *
 * When the instrument is quoted in a currency other than the account's, this
 * returns '—'. Converting would mean inventing an FX rate the browser does not
 * hold; the server has one and will apply it. A wrong number here is worse than
 * no number.
 */
export function estimateCosts(
  spec: SymbolRow | undefined,
  account: AccountSummary | undefined,
  volume: string,
  executable: string | null,
  volumeOk: boolean,
): { margin: string; commission: string } {
  const blank = { margin: '—', commission: '—' };
  if (spec === undefined || account === undefined || executable === null || !volumeOk) return blank;
  if (spec.quoteCurrency !== account.currency) return blank;

  try {
    const margin = requiredMargin({
      spec: spec as SymbolSpec,
      volume,
      price: executable,
      accountLeverage: account.leverage,
      accountCurrency: account.currency as SymbolSpec['quoteCurrency'],
      quoteToAccountRate: 1,
    });
    const commission = toDecimal(spec.commissionPerLot).mul(toDecimal(volume));
    return {
      margin: money(margin.toString(), account.currency),
      commission: money(commission.toFixed(2), account.currency),
    };
  } catch {
    // A spec the browser cannot price is a display problem, not a trading one.
    return blank;
  }
}

/**
 * Pre-flight for a resting order's price.
 *
 * Runs the same `validatePendingPrice` the API runs, from the same package, so
 * the browser cannot invent a rule the server lacks or miss one it has. Its
 * whole job is to catch the mistake that matters: a price on the wrong side of
 * the market is not a resting order at all — it fires on the next tick, and the
 * trader gets a market order they never asked for.
 *
 * Returns the message rather than throwing, because a half-typed price is the
 * normal state of an input the user is still filling in.
 */
export function validateRestingPrice(
  spec: SymbolRow | undefined,
  type: 'LIMIT' | 'STOP',
  side: 'BUY' | 'SELL',
  price: string,
  quote: { bid: string; ask: string } | undefined,
): string | null {
  const trimmed = price.trim();
  if (spec === undefined) return null;
  if (trimmed === '') return 'Enter the price the order should rest at.';
  if (!isDecimalString(trimmed)) return 'Price must be a decimal number.';
  // Without a quote there is nothing to measure the side against; the server
  // has one and will refuse the order if it is wrong.
  if (quote === undefined) return null;

  try {
    validatePendingPrice(spec as SymbolSpec, type, side, trimmed, quote);
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.message : 'Invalid price.';
  }
}

/**
 * What the stop and the target on *this* ticket would be worth.
 *
 * A projection of an order that does not exist yet, which makes it two steps
 * removed from a fact: the entry has not happened, and neither has the exit. It
 * is still worth showing, because "risking 180 to make 240" is the question
 * every trader is actually answering when they type a stop, and making them do
 * that arithmetic in their head is how position sizes go wrong.
 *
 * Three rules keep it honest:
 *
 *  - it runs `grossPnl` from `@tp/financial-core`, the engine's own formula, so
 *    the browser cannot invent an arithmetic the server does not have;
 *  - it returns `null`, not zero, whenever an input is missing — a dash says
 *    "not known", a zero says "costs you nothing", and only one of those is
 *    true;
 *  - it refuses to convert. When the instrument is quoted in a currency other
 *    than the account's it returns `null` rather than applying an FX rate this
 *    browser does not hold, exactly as `estimateCosts` does.
 *
 * Gross, not net: commission is shown on its own line above and swap depends on
 * how long the position is held, which nobody knows at the moment of entry.
 */
export function projectedOutcome(
  spec: SymbolRow | undefined,
  account: AccountSummary | undefined,
  side: 'BUY' | 'SELL',
  volume: string,
  entryPrice: string | null,
  exitPrice: string,
): string | null {
  if (spec === undefined || account === undefined || entryPrice === null) return null;
  if (spec.quoteCurrency !== account.currency) return null;
  const exit = exitPrice.trim();
  if (exit === '' || !isDecimalString(exit) || !isDecimalString(volume)) return null;

  try {
    return grossPnl({
      spec: spec as SymbolSpec,
      side,
      volume,
      entryPrice,
      exitPrice: exit,
      accountCurrency: account.currency,
      quoteToAccountRate: '1',
    }).toString();
  } catch {
    // A half-typed level is the normal state of an input being filled in.
    return null;
  }
}

/**
 * Reward divided by risk, as a plain ratio.
 *
 * `null` unless both projections exist and the risk side is actually a loss —
 * a "risk" that is positive means the stop is on the wrong side of the entry,
 * and dividing by it would print a confident, meaningless number.
 */
export function rewardToRisk(profit: string | null, loss: string | null): string | null {
  if (profit === null || loss === null) return null;
  const reward = Number(profit);
  const risk = Number(loss);
  if (!Number.isFinite(reward) || !Number.isFinite(risk)) return null;
  if (risk >= 0 || reward <= 0) return null;
  return (reward / Math.abs(risk)).toFixed(2);
}
