import { describe, expect, it } from 'vitest';
import { ERROR_WORDS, explainError } from './error-words';
import { END_ISOLATE, LTR_ISOLATE, en, fa } from './messages';

const t = (table: Record<string, string>) => (key: string) => table[key] ?? key;

describe('refusals in the reader’s language', () => {
  it('keeps the server’s specific message in English', () => {
    expect(
      explainError('INVALID_STOP_LOSS', 'A BUY stop loss must sit below 4584.6', 'en', t(en)),
    ).toBe('A BUY stop loss must sit below 4584.6');
  });

  it('puts the Persian sentence first and keeps the server’s figures, isolated', () => {
    const text = explainError('INSUFFICIENT_MARGIN', 'Free margin 12.50 < 40.00', 'fa', t(fa));
    expect(text.startsWith(fa['err.INSUFFICIENT_MARGIN'])).toBe(true);
    expect(text).toContain(`${LTR_ISOLATE}Free margin 12.50 < 40.00${END_ISOLATE}`);
  });

  it('falls back to the server’s message for a code it has no words for', () => {
    expect(explainError('SOMETHING_NEW', 'Detail', 'fa', t(fa))).toBe('Detail');
  });

  it('has words in both languages for every code it names', () => {
    for (const key of Object.values(ERROR_WORDS)) {
      expect(en[key], key).toBeTruthy();
      expect(fa[key], key).toBeTruthy();
    }
  });
});
