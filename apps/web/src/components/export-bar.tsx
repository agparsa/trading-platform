'use client';

import { downloadCsv, toCsv } from '@/lib/csv';
import { Button } from './primitives';

/**
 * A count and an "Export CSV" button above a table: a download of exactly
 * what is on screen.
 *
 * Built from the rows already rendered rather than from a fresh request: a
 * second query could return something else — history grows while you read
 * it — and an export that silently disagrees with the screen it came from is
 * worse than no export.
 *
 * Every value is the server's own decimal string, unformatted. The table
 * rounds for display; a file somebody will reconcile against their own
 * records must not. The rows given are the rows written — a filtered table
 * exports what it shows, and the label says how many that is.
 */
export function ExportBar({
  label,
  filename,
  columns,
  rows,
  children,
}: {
  label: string;
  filename: string;
  columns: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
  /** Controls beside the label — a filter box, say. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-terminal-border px-3 py-1.5">
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-terminal-muted">{label}</span>
        {children}
      </div>
      <Button
        variant="ghost"
        className="px-2 py-0.5"
        disabled={rows.length === 0}
        onClick={() =>
          downloadCsv(
            toCsv(columns, rows),
            `${filename}-${new Date().toISOString().slice(0, 10)}.csv`,
          )
        }
      >
        Export CSV
      </Button>
    </div>
  );
}
