import { Decimal, Money, type CurrencyCode } from '@tp/financial-core';

/**
 * An account's trading performance over a period, from its closed trades.
 *
 * Every figure comes from `Trade.netPnl` — what the round trip left on the
 * balance after commission and swap — and nothing else: no open position, no
 * quote, no estimate. A trade belongs to the day and the month it *closed*,
 * in the trading server's timezone, because that is when its result reached
 * the balance.
 *
 * Definitions, because each of these words has more than one in the trade:
 *
 * - **Profitable / losing:** net P&L above / below zero. A trade that came out
 *   at exactly zero is counted in the total and in neither column.
 * - **Average win / loss:** the mean net P&L of profitable / losing trades.
 *   The loss is shown as the negative number it is.
 * - **Profit factor:** gross profit ÷ |gross loss|, to two places. `null`
 *   when there is no loss to divide by — "infinite" is not a number a trader
 *   can compare, and 0 would claim the opposite of the truth.
 * - **Return:** the period's net P&L as a percentage of the balance at the
 *   period's start. `null` when that balance is zero or unknown (an account
 *   funded inside the period). Deposits and withdrawals are not trading
 *   results and are not in the numerator.
 */
export interface ClosedTradeFigure {
  readonly side: 'BUY' | 'SELL';
  readonly netPnl: string;
  readonly exitTime: Date;
}

export interface SideSummary {
  readonly total: number;
  readonly profitable: number;
  readonly losing: number;
}

export interface Performance {
  readonly currency: string;
  readonly trades: {
    readonly total: number;
    readonly buys: SideSummary;
    readonly sells: SideSummary;
  };
  readonly netPnl: string;
  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly averageWin: string | null;
  readonly averageLoss: string | null;
  readonly profitFactor: string | null;
  readonly startingBalance: string | null;
  readonly returnPercent: string | null;
  readonly days: { readonly total: number; readonly profitable: number; readonly losing: number };
  /** One entry per month that had a closed trade, oldest first: `YYYY-MM`. */
  readonly months: ReadonlyArray<{
    readonly month: string;
    readonly netPnl: string;
    readonly trades: number;
  }>;
}

/** `YYYY-MM-DD` of an instant in a timezone. */
export function dayIn(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD; the parts are read rather than the string, so
  // a locale change in the runtime cannot reorder them.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((one) => one.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function performanceOf(input: {
  readonly trades: readonly ClosedTradeFigure[];
  readonly currency: CurrencyCode;
  readonly timeZone: string;
  readonly startingBalance: string | null;
}): Performance {
  const zero = Money.zero(input.currency);
  const money = (value: string) => Money.of(value, input.currency);
  let grossProfit = zero;
  let grossLoss = zero;
  let wins = 0;
  let losses = 0;
  const side = {
    BUY: { total: 0, profitable: 0, losing: 0 },
    SELL: { total: 0, profitable: 0, losing: 0 },
  };
  const byDay = new Map<string, Money>();
  const byMonth = new Map<string, { net: Money; trades: number }>();

  for (const trade of input.trades) {
    const net = money(trade.netPnl);
    const summary = side[trade.side];
    summary.total += 1;
    if (net.isPositive()) {
      grossProfit = grossProfit.plus(net);
      wins += 1;
      summary.profitable += 1;
    } else if (net.isNegative()) {
      grossLoss = grossLoss.plus(net);
      losses += 1;
      summary.losing += 1;
    }
    const day = dayIn(trade.exitTime, input.timeZone);
    byDay.set(day, (byDay.get(day) ?? zero).plus(net));
    const month = day.slice(0, 7);
    const sofar = byMonth.get(month) ?? { net: zero, trades: 0 };
    byMonth.set(month, { net: sofar.net.plus(net), trades: sofar.trades + 1 });
  }

  const net = grossProfit.plus(grossLoss);
  const days = [...byDay.values()];
  const start = input.startingBalance === null ? null : new Decimal(input.startingBalance);

  return {
    currency: input.currency,
    trades: { total: input.trades.length, buys: side.BUY, sells: side.SELL },
    netPnl: net.toString(),
    grossProfit: grossProfit.toString(),
    grossLoss: grossLoss.toString(),
    averageWin: wins === 0 ? null : grossProfit.dividedBy(wins).toString(),
    averageLoss: losses === 0 ? null : grossLoss.dividedBy(losses).toString(),
    profitFactor: grossLoss.isZero()
      ? null
      : grossProfit.amount.dividedBy(grossLoss.abs().amount).toFixed(2, Decimal.ROUND_HALF_UP),
    startingBalance: start === null ? null : input.startingBalance,
    returnPercent:
      start === null || start.lte(0)
        ? null
        : net.amount.dividedBy(start).times(100).toFixed(2, Decimal.ROUND_HALF_UP),
    days: {
      total: days.length,
      profitable: days.filter((one) => one.isPositive()).length,
      losing: days.filter((one) => one.isNegative()).length,
    },
    months: [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, value]) => ({ month, netPnl: value.net.toString(), trades: value.trades })),
  };
}
