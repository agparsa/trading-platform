import { describe, expect, it } from 'vitest';
import { csvField, toCsv } from './csv';

describe('csvField', () => {
  it('quotes every field, so a comma cannot become a column', () => {
    expect(csvField('hello')).toBe('"hello"');
    expect(csvField('a,b')).toBe('"a,b"');
  });

  it('doubles an embedded quote', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('keeps a newline inside its field', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  /**
   * An exported audit trail is exactly the kind of file somebody opens in Excel
   * without thinking about it, and its contents came from user input.
   */
  it('defuses a field a spreadsheet would run as a formula', () => {
    expect(csvField('=1+1')).toBe(`"'=1+1"`);
    expect(csvField('+44 7700 900000')).toBe(`"'+44 7700 900000"`);
    expect(csvField('-100')).toBe(`"'-100"`);
    expect(csvField('@SUM(A1:A9)')).toBe(`"'@SUM(A1:A9)"`);
  });

  /** A leading tab is stripped before the formula check, so it must be caught too. */
  it('defuses one hidden behind whitespace a spreadsheet ignores', () => {
    expect(csvField('\t=cmd|calc')).toBe(`"'\t=cmd|calc"`);
    expect(csvField('\r=cmd')).toBe(`"'\r=cmd"`);
  });

  it('leaves an ordinary number alone', () => {
    expect(csvField('1250.00')).toBe('"1250.00"');
  });

  it('handles an empty field', () => {
    expect(csvField('')).toBe('""');
  });
});

describe('toCsv', () => {
  it('writes a header and rows separated by CRLF', () => {
    const csv = toCsv(
      ['when', 'action'],
      [
        ['2026-08-29 12:00:00', 'user.suspended'],
        ['2026-08-29 12:01:00', 'user.reinstated'],
      ],
    );
    expect(csv).toBe(
      '"when","action"\r\n' +
        '"2026-08-29 12:00:00","user.suspended"\r\n' +
        '"2026-08-29 12:01:00","user.reinstated"',
    );
  });

  it('survives a JSON payload full of the characters CSV cares about', () => {
    const payload = JSON.stringify({ reason: 'He said "no", then left\nafter', amount: -250 });
    const csv = toCsv(['after'], [[payload]]);
    // One header line and one data line, whatever is inside the payload — the
    // embedded newline must not become a second record.
    expect(csv.split('\r\n')).toHaveLength(2);
    // The JSON's own escaped quotes are doubled again for CSV, so a reader that
    // unquotes correctly gets the original payload back.
    expect(csv).toContain('\\""no\\""');
    const field = csv.split('\r\n')[1] ?? '';
    expect(JSON.parse(field.slice(1, -1).replace(/""/g, '"'))).toEqual({
      reason: 'He said "no", then left\nafter',
      amount: -250,
    });
  });

  it('writes just a header when there is nothing to export', () => {
    expect(toCsv(['when'], [])).toBe('"when"');
  });
});
