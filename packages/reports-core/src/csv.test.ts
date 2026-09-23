import { describe, expect, it } from 'vitest';
import { csvField, toCsv, UTF8_BOM } from './csv';

describe('csvField', () => {
  it('quotes every field and doubles embedded quotes', () => {
    expect(csvField('plain')).toBe('"plain"');
    expect(csvField('has,comma')).toBe('"has,comma"');
    expect(csvField('has"quote')).toBe('"has""quote"');
    expect(csvField('has\nnewline')).toBe('"has\nnewline"');
  });

  /**
   * The half that is a security control rather than a formatting rule.
   *
   * A statement is opened in Excel by somebody who is not thinking about it,
   * and the contents came from user input — a description an operator typed, a
   * rejection reason. Every one of these is a live formula unguarded.
   */
  it.each(['=cmd|calc', '+1', '-1+1', '@SUM(A1)', '\t=cmd', '\r=cmd'])('defuses %j', (payload) => {
    expect(csvField(payload)).toBe(`"'${payload}"`);
  });

  it('leaves a value that merely contains those characters alone', () => {
    // Only the *leading* character matters, and over-quoting would corrupt
    // ordinary data — an email address, a negative amount mid-string.
    expect(csvField('a=b')).toBe('"a=b"');
    expect(csvField('x@example.test')).toBe('"x@example.test"');
  });

  it('guards a negative amount, which is a real field in these reports', () => {
    // `-1500.00` is what a withdrawal looks like in the ledger export, and it
    // is also a formula. The apostrophe is correct and the cell still reads as
    // the number to a human.
    expect(csvField('-1500.00')).toBe(`"'-1500.00"`);
  });
});

describe('toCsv', () => {
  it('joins with CRLF, as RFC 4180 and Excel both want', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe('"a","b"\r\n"1","2"');
  });

  it('produces a header even with no rows', () => {
    // An empty report is a valid answer — "nothing happened in that window" —
    // and a file with no header is one somebody cannot read.
    expect(toCsv(['a', 'b'], [])).toBe('"a","b"');
  });

  it('has a BOM available for Excel', () => {
    expect(UTF8_BOM).toBe('﻿');
    expect(Buffer.from(UTF8_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
