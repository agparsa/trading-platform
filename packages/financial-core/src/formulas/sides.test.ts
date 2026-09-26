import { describe, expect, it } from 'vitest';
import { entryPriceFor, entrySideOf, exitPriceFor, exitSideOf } from './sides';

const quote = { bid: '1.10000', ask: '1.10020' };

describe('the side of the book', () => {
  it('opens a long at the ask and values it at the bid', () => {
    expect(entrySideOf('BUY')).toBe('ask');
    expect(exitSideOf('BUY')).toBe('bid');
    expect(entryPriceFor('BUY', quote).toString()).toBe('1.1002');
    expect(exitPriceFor('BUY', quote).toString()).toBe('1.1');
  });

  it('opens a short at the bid and values it at the ask', () => {
    expect(entrySideOf('SELL')).toBe('bid');
    expect(exitSideOf('SELL')).toBe('ask');
    expect(entryPriceFor('SELL', quote).toString()).toBe('1.1');
    expect(exitPriceFor('SELL', quote).toString()).toBe('1.1002');
  });

  it('hands back the quote exactly as printed, for callers that show it', () => {
    expect(quote[entrySideOf('BUY')]).toBe('1.10020');
  });
});
