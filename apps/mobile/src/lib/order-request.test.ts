import { describe, expect, it } from 'vitest';
import {
  offeredOrderKinds,
  offersTrailing,
  orderRequest,
  restingFieldsProblem,
  restingOrderRequest,
  restingSummary,
  type TicketFields,
} from './order-request';

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

describe('a resting order from the phone', () => {
  it('sends where it rests, and a stop only for a stop-limit', () => {
    const limit = restingOrderRequest({
      ...fields,
      kind: 'LIMIT',
      price: ' 4550.00 ',
      stopPrice: '4540.00',
      timeInForce: 'GTC',
    });
    expect(limit).toMatchObject({ type: 'LIMIT', price: '4550.00', timeInForce: 'GTC' });
    // The API refuses a stop price on a limit; a stale field must not reach it.
    expect(limit).not.toHaveProperty('stopPrice');

    const stopLimit = restingOrderRequest({
      ...fields,
      kind: 'STOP_LIMIT',
      price: '4602.00',
      stopPrice: ' 4600.00',
      timeInForce: 'DAY',
      trailingDistance: '3',
    });
    expect(stopLimit).toMatchObject({
      type: 'STOP_LIMIT',
      price: '4602.00',
      stopPrice: '4600.00',
      timeInForce: 'DAY',
      trailingStopDistance: '3',
    });
  });

  it('says which price is missing before anything is reviewed', () => {
    expect(restingFieldsProblem('MARKET', '', '')).toBeNull();
    expect(restingFieldsProblem('LIMIT', '', '')).toBe('Enter the limit price.');
    expect(restingFieldsProblem('STOP', 'abc', '')).toBe('The stop price must be a number.');
    expect(restingFieldsProblem('STOP_LIMIT', '4602', '')).toBe('Enter the stop price.');
    expect(restingFieldsProblem('STOP_LIMIT', '', '4600')).toBe('Enter the limit price.');
    expect(restingFieldsProblem('STOP_LIMIT', '4602', '4600')).toBeNull();
  });

  it('offers a stop-limit unless the firm has switched it off', () => {
    expect(offeredOrderKinds(undefined)).toContain('STOP_LIMIT');
    expect(offeredOrderKinds({ stop_limit: true })).toContain('STOP_LIMIT');
    expect(offeredOrderKinds({ stop_limit: false })).toEqual(['MARKET', 'LIMIT', 'STOP']);
  });

  it('names the order in one sentence for the confirmation', () => {
    const base = { ...fields, timeInForce: 'GTC' as const, stopPrice: '4600.00' };
    expect(restingSummary(restingOrderRequest({ ...base, kind: 'LIMIT', price: '4550.00' }))).toBe(
      'BUY 0.10 XAUUSD limit at 4550.00, until cancelled.',
    );
    expect(
      restingSummary(
        restingOrderRequest({ ...base, kind: 'STOP_LIMIT', price: '4602.00', timeInForce: 'DAY' }),
      ),
    ).toBe(
      'BUY 0.10 XAUUSD stop-limit stop 4600.00, then limit 4602.00, until the end of the trading day.',
    );
  });
});
