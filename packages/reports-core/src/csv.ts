/**
 * CSV, done properly — the server's copy of a rule the browser already knew.
 *
 * `apps/web/src/lib/csv.ts` has carried this logic since the panel's first
 * export button, and its reasoning is worth repeating here rather than
 * paraphrasing, because both halves are load-bearing:
 *
 * **Quoting.** RFC 4180: every field quoted, every embedded quote doubled. Not
 * optional for this data — an audit payload or a rejection reason contains
 * commas, newlines and quotation marks as a matter of course, and a file that
 * splits one value across three columns misrepresents the record it exists to
 * preserve.
 *
 * **Formula injection.** A field beginning `=`, `+`, `-` or `@` is executed as
 * a formula by every spreadsheet there is, and a leading tab or carriage return
 * is stripped before that check — so `\t=cmd` is a live formula in a naive
 * guard. An exported statement is exactly the kind of file somebody opens in
 * Excel without thinking about it, and the contents came from user input.
 *
 * ## Why this is a copy and not an import
 *
 * The browser module reaches for `Blob` and `URL.createObjectURL`; importing it
 * into a worker would drag the DOM in. Splitting the pure half out of it and
 * sharing that is the better shape and it is a refactor of a working module for
 * a benefit this phase does not need — so: a copy, named as one, with the two
 * kept honest by `csv.parity.test.ts`, which runs the same inputs through both
 * and fails if they ever disagree. A duplicate nobody checks is the thing worth
 * avoiding; a duplicate a test pins is a decision.
 */

/** One CSV field: quoted, escaped, and defused. */
export function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** One CSV row. */
export function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

/**
 * The byte-order mark Excel needs to read UTF-8 as UTF-8.
 *
 * Without it, Excel on a Windows machine in a non-UTF-8 locale reads the file
 * in the local code page and mangles every name that is not ASCII. The BOM is
 * three bytes and it is the difference between a usable statement and a support
 * ticket.
 */
export const UTF8_BOM = '﻿';

/** A whole document, for a report small enough to assemble in memory. */
export function toCsv(
  columns: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  // CRLF: RFC 4180 says so, and Excel on Windows is the reader that cares.
  return [csvRow(columns), ...rows.map(csvRow)].join('\r\n');
}
