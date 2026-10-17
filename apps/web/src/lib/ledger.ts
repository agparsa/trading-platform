import type { LedgerEntryRow } from './queries';

/**
 * Balance history, in a trader's words.
 *
 * The ledger's own vocabulary (`LedgerEntryType` in the schema) is the
 * engine's: TRADE_PROFIT and TRADE_LOSS are two names for one event, a
 * position closing, with the sign of the amount telling them apart. On a
 * statement they are read as "Closed trade" either way, and the amount's
 * colour and sign say which way it went.
 *
 * A type this table does not know is shown as the server spelled it rather
 * than dropped: an entry the screen hides is an entry the balance cannot be
 * reconciled against.
 */
export const LEDGER_TYPE_LABEL: Record<string, string> = {
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  TRADE_PROFIT: 'Closed trade',
  TRADE_LOSS: 'Closed trade',
  COMMISSION: 'Commission',
  SWAP: 'Swap',
  FEE: 'Fee',
  ADJUSTMENT: 'Adjustment',
};

export function ledgerLabel(type: string): string {
  return LEDGER_TYPE_LABEL[type] ?? type;
}

/**
 * Every page's entries in one list, newest first, each once.
 *
 * The server's pages do not overlap. A refetch that lands between two pages
 * can still hand one entry back in both — a new entry pushes the boundary —
 * so an id seen once is not shown twice.
 */
export function ledgerEntries(
  pages: ReadonlyArray<{ entries: readonly LedgerEntryRow[] }> | undefined,
): LedgerEntryRow[] {
  const seen = new Set<string>();
  const out: LedgerEntryRow[] = [];
  for (const page of pages ?? []) {
    for (const entry of page.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}
