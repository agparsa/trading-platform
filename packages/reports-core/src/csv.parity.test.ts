import { describe, expect, it } from 'vitest';
import { csvField as serverField, toCsv as serverCsv } from './csv';
import { csvField as browserField, toCsv as browserCsv } from '@/lib/csv';

/**
 * The server's CSV and the browser's must never disagree.
 *
 * `apps/web/src/lib/csv.ts` had this logic first. This package needed the pure
 * half of it and could not import the module, which reaches for `Blob` and
 * `URL.createObjectURL`. Splitting the browser module in two would have been
 * the better shape and a refactor of working code for a benefit this phase does
 * not need — so there are two copies, named as copies.
 *
 * A duplicate nobody checks is the thing worth avoiding. This is the check: the
 * browser's own module is imported — importing it is safe because its DOM use
 * is inside `downloadCsv` and nothing here calls it — and the same inputs go
 * through both. If somebody hardens one against a new spreadsheet trick and
 * forgets the other, a downloaded statement and an on-screen export stop
 * agreeing, and the one that is wrong is whichever was not touched. That is not
 * something you notice by reading either file.
 */

describe('server and browser CSV agree', () => {
  it('imported the browser module, rather than silently testing nothing', () => {
    // The failure mode of every check that reaches into another package.
    expect(typeof browserField).toBe('function');
    expect(browserField('plain')).toBe('"plain"');
  });

  const FIELDS = [
    'plain',
    '',
    'has,comma',
    'has"quote',
    'has\nnewline',
    'has\r\ncrlf',
    '=cmd|calc',
    '+1',
    '-1500.00',
    '@SUM(A1)',
    '\t=cmd',
    '\r=cmd',
    'a=b',
    'x@example.test',
    'quote"and,comma',
    '  leading spaces',
    'نام فارسی',
    '日本語',
    '😀 emoji',
  ];

  it.each(FIELDS)('quote %j identically', (value) => {
    expect(serverField(value)).toBe(browserField(value));
  });

  /**
   * Every leading character, generated rather than listed.
   *
   * The hand-written corpus above only compares inputs somebody thought of, and
   * that is exactly how a parity check rots: adding `\n` to one guard and not
   * the other survived it, because no example happened to start with a newline.
   * Sweeping the whole plausible leading-character space means a divergence in
   * the guard *set* is caught whichever way it goes, without anybody having to
   * predict which character the next spreadsheet trick will use.
   */
  const LEADING = [
    ...'=+-@ \t\r\n\v\f\u00a0\u200b\u2212!#$%^&*()[]{}<>?/\\|~`\'";:,.0123456789aZ',
  ];

  it.each(LEADING)('agree on a field starting with %j', (lead) => {
    const value = `${lead}cmd|calc`;
    expect(serverField(value)).toBe(browserField(value));
  });

  it('assemble a whole document identically', () => {
    const columns = ['id', 'amount', 'note'];
    const rows = [
      ['1', '-1500.00', 'refund, as agreed'],
      ['2', '10.00', 'he said "fine"'],
      ['3', '0', '=HYPERLINK("http://x","click")'],
    ];
    expect(serverCsv(columns, rows)).toBe(browserCsv(columns, rows));
  });
});
