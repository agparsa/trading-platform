import type { CandleRow } from './queries';

/**
 * Live bars win over the stored series for the same bucket.
 *
 * The REST rows were true when they were fetched; a bar the socket has since
 * updated is more recent. Merging on bar time rather than appending means a
 * refetch that overlaps the live window cannot produce two bars for one minute —
 * which on a chart looks like a price that moved twice.
 */
export function mergeBars(
  history: readonly CandleRow[],
  live: Record<number, CandleRow> | undefined,
): CandleRow[] {
  const merged = new Map<number, CandleRow>();
  for (const bar of history) merged.set(bar.time, bar);
  for (const bar of Object.values(live ?? {})) merged.set(bar.time, bar);
  return [...merged.values()].sort((a, b) => a.time - b.time);
}
