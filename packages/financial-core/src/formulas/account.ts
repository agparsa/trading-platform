import { type Decimal, type DecimalInput, toDecimal } from '../decimal';
import { type Money } from '../money';
import type { CurrencyCode } from '../currency';

/**
 * The authoritative account-state formulas.
 *
 * Accounting conventions, fixed here and nowhere else:
 *
 *  - Commission is realized at open. It hits the balance ledger the moment a
 *    position is created, so it is already inside `balance`.
 *  - Swap is accrued nightly into the balance ledger, so it is already inside
 *    `balance` too.
 *  - `floatingPnl` is therefore pure price P&L on open positions, with no fees
 *    folded in. Double-counting fees is the classic way these numbers drift.
 *
 *      equity      = balance + floatingPnl
 *      freeMargin  = equity - usedMargin
 *      marginLevel = equity / usedMargin x 100      (undefined when usedMargin = 0)
 */
export interface AccountStateInput {
  readonly currency: CurrencyCode;
  readonly balance: Money;
  /** Sum of price P&L across all open positions, in account currency. */
  readonly floatingPnl: Money;
  /** Sum of initial margin held against open positions. */
  readonly usedMargin: Money;
}

export interface AccountState {
  readonly currency: CurrencyCode;
  readonly balance: Money;
  readonly equity: Money;
  readonly floatingPnl: Money;
  readonly usedMargin: Money;
  readonly freeMargin: Money;
  /** Percentage. `null` when no margin is used — not Infinity, not 0. */
  readonly marginLevel: Decimal | null;
}

export function equity(balance: Money, floatingPnl: Money): Money {
  return balance.plus(floatingPnl);
}

export function freeMargin(equityValue: Money, usedMargin: Money): Money {
  return equityValue.minus(usedMargin);
}

/**
 * Margin level as a percentage.
 *
 * Returns `null` rather than Infinity when nothing is committed. An account with
 * no open positions does not have an infinitely good margin level — the ratio
 * is simply undefined, and every consumer must handle that case explicitly.
 */
export function marginLevel(equityValue: Money, usedMargin: Money): Decimal | null {
  if (usedMargin.isZero()) return null;
  return equityValue.amount.div(usedMargin.amount).mul(100);
}

/**
 * Margin utilisation: usedMargin / equity x 100.
 *
 * Distinct from `marginLevel`, and easy to confuse with it. MetaTrader-style
 * platforms show margin *level* (equity / margin, healthy when large); several
 * modern terminals label utilisation as "Margin Level" (healthy when small).
 * Both are exposed here under unambiguous names so the UI can pick one and the
 * risk engine can rely on the other.
 */
export function marginUtilization(equityValue: Money, usedMargin: Money): Decimal | null {
  if (equityValue.isZero()) return null;
  return usedMargin.amount.div(equityValue.amount).mul(100);
}

export function computeAccountState(input: AccountStateInput): AccountState {
  const eq = equity(input.balance, input.floatingPnl);
  return {
    currency: input.currency,
    balance: input.balance,
    equity: eq,
    floatingPnl: input.floatingPnl,
    usedMargin: input.usedMargin,
    freeMargin: freeMargin(eq, input.usedMargin),
    marginLevel: marginLevel(eq, input.usedMargin),
  };
}

/**
 * True when the account has fallen to or below the stop-out level and positions
 * must be liquidated. A `null` margin level (nothing open) is never a stop-out.
 */
export function isStopOut(state: AccountState, stopOutLevelPercent: DecimalInput): boolean {
  if (state.marginLevel === null) return false;
  return state.marginLevel.lte(toDecimal(stopOutLevelPercent));
}

export function isMarginCall(state: AccountState, marginCallLevelPercent: DecimalInput): boolean {
  if (state.marginLevel === null) return false;
  return state.marginLevel.lte(toDecimal(marginCallLevelPercent));
}
