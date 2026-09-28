import { describe, expect, it } from 'vitest';
import { offersTrailing, orderRequest, type TicketFields } from './order-request';

const fields: TicketFields = {
  accountId: 'acc-1',
  symbol: 'XAUUSD',
  side: 'BUY',
  volume: '0.10',
  stopLoss: '',
  takeProfit: '',
  trailingDistance: '',
};

describe('the phone’s order request', () => {
  it('sends empty levels as null and no trail key at all when none was typed', () => {
    const body = orderRequest(fields);
    expect(body).toEqual({
      accountId: 'acc-1',
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
      stopLoss: null,
      takeProfit: null,
    });
    // Absent, not null: the server consults the firm's flag only when the
    // key is present, and a null here would be a trail of "nothing".
    expect(body).not.toHaveProperty('trailingStopDistance');
  });

  it('sends every field the trader filled in, trimmed', () => {
    expect(
      orderRequest({
        ...fields,
        volume: ' 0.25 ',
        stopLoss: '3988.00 ',
        takeProfit: ' 4012.00',
        trailingDistance: ' 5.00 ',
      }),
    ).toEqual({
      accountId: 'acc-1',
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.25',
      stopLoss: '3988.00',
      takeProfit: '4012.00',
      trailingStopDistance: '5.00',
    });
  });

  it('treats a field of spaces as empty', () => {
    const body = orderRequest({ ...fields, stopLoss: '   ', trailingDistance: '  ' });
    expect(body.stopLoss).toBeNull();
    expect(body).not.toHaveProperty('trailingStopDistance');
  });
});

describe('offering the trailing field', () => {
  it('is hidden only when the firm has switched trailing off', () => {
    expect(offersTrailing({ trailing_stop: false })).toBe(false);
    expect(offersTrailing({ trailing_stop: true })).toBe(true);
    // Unknown — not loaded, or the request failed — offers it; the server
    // refuses a trail the firm does not allow whatever the phone shows.
    expect(offersTrailing(undefined)).toBe(true);
    expect(offersTrailing({})).toBe(true);
  });
});
