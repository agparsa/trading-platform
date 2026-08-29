/**
 * CSV, done properly.
 *
 * Two things make this worth its own module rather than a template string.
 *
 * **Quoting.** RFC 4180: every field quoted, every embedded quote doubled. Not
 * optional for this data — an audit `after` blob contains commas, newlines and
 * quotation marks as a matter of course, and a file that splits one JSON
 * payload across three columns misrepresents the record it exists to preserve.
 *
 * **Formula injection.** A field beginning `=`, `+`, `-` or `@` is executed as a
 * formula by every spreadsheet application there is. An exported audit trail is
 * exactly the kind of file somebody opens in Excel without thinking about it,
 * and the contents came from user input — an email address, a reason somebody
 * typed. Prefixing an apostrophe makes the cell text, which is what it was.
 */

export function csvField(value: string): string {
  // Tab and carriage return count: a leading tab is stripped by the spreadsheet
  // before the formula check, so `\t=cmd` is a live formula in a naive guard.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One CSV document from a header and rows of already-stringified fields. */
export function toCsv(columns: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  // CRLF: RFC 4180 says so, and Excel on Windows is the reader that cares.
  return [columns.map(csvField).join(','), ...rows.map((row) => row.map(csvField).join(','))].join(
    '\r\n',
  );
}

/**
 * Hands the browser a file.
 *
 * The blob URL is revoked immediately after the click. Leaving it alive keeps
 * the whole exported table in memory for the life of the tab, which on a
 * console somebody leaves open all day is a leak that grows with every export.
 *
 * The BOM is deliberate: Excel reads a UTF-8 file without one as the local
 * codepage and turns every non-ASCII character in an email address into
 * mojibake.
 */
export function downloadCsv(csv: string, filename: string): void {
  if (typeof document === 'undefined') return;
  // U+FEFF, written as an escape rather than as a literal so it is visible to
  // whoever reads this file next.
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
