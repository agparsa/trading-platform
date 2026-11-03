/**
 * The History tab's summary of the last three months, from
 * `GET /accounts/:id/performance?period=3M` — the same figures the web's
 * Analytics page shows, computed by the server from closed trades.
 *
 * Laid out here, not calculated: every value is the server's string. A
 * figure the server withholds (no profit factor without a losing trade, no
 * return without a balance from before the period) is a dash, never a zero,
 * and the reason travels with it.
 */
export interface PerformanceSummaryInput {
  readonly trades: {
    readonly total: number;
    readonly buys: { readonly profitable: number; readonly losing: number };
    readonly sells: { readonly profitable: number; readonly losing: number };
  };
  readonly netPnl: string;
  readonly returnPercent: string | null;
  readonly averageWin: string | null;
  readonly averageLoss: string | null;
  readonly profitFactor: string | null;
}

export interface SummaryLine {
  readonly label: string;
  readonly value: string;
  /** The figure whose sign colours the line, when one should. */
  readonly signOf: string | null;
}

const signed = (value: string) => (value.startsWith('-') ? value : `+${value}`);

export function performanceSummary(input: PerformanceSummaryInput): {
  lines: SummaryLine[];
  notes: string[];
} {
  const won = input.trades.buys.profitable + input.trades.sells.profitable;
  const lost = input.trades.buys.losing + input.trades.sells.losing;
  const notes: string[] = [];
  if (input.returnPercent === null) {
    notes.push('No return: the account had no balance before these three months.');
  }
  if (input.profitFactor === null && input.trades.total > 0) {
    notes.push('No profit factor: no trade lost money.');
  }
  return {
    lines: [
      { label: 'Net result', value: signed(input.netPnl), signOf: input.netPnl },
      {
        label: 'Return',
        value: input.returnPercent === null ? '—' : `${signed(input.returnPercent)}%`,
        signOf: input.returnPercent,
      },
      { label: 'Trades', value: `${input.trades.total} (${won} won, ${lost} lost)`, signOf: null },
      { label: 'Profit factor', value: input.profitFactor ?? '—', signOf: null },
      {
        label: 'Average win',
        value: input.averageWin === null ? '—' : signed(input.averageWin),
        signOf: input.averageWin,
      },
      {
        label: 'Average loss',
        value: input.averageLoss === null ? '—' : signed(input.averageLoss),
        signOf: input.averageLoss,
      },
    ],
    notes,
  };
}
