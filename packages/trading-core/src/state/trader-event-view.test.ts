import { describe, expect, it } from 'vitest';
import { traderEventPayload } from './trader-event-view';

describe('an order event, as its owner sees it', () => {
  it("drops the venue's side of a venue-executed order", () => {
    expect(
      traderEventPayload({
        volume: '1.00',
        venue: 'c0ffee00-0000-4000-8000-000000000000',
        connectionId: 'c0ffee00-0000-4000-8000-000000000000',
        clientOrderId: 'tp-123',
        externalOrderId: 'MO-9',
        externalSymbol: 'GOLD.x',
        externalAccountId: 'ACC-77',
      }),
    ).toEqual({ volume: '1.00' });
  });

  it('keeps what explains the order: prices, the reason, who changed it', () => {
    expect(
      traderEventPayload({
        price: '4600.00',
        bid: '4599.9',
        ask: '4600.1',
        reason: 'STOP_REACHED',
        by: 'SYSTEM',
      }),
    ).toEqual({
      price: '4600.00',
      bid: '4599.9',
      ask: '4600.1',
      reason: 'STOP_REACHED',
      by: 'SYSTEM',
    });
  });

  it('hides a key nobody has decided to show, and anything nested', () => {
    expect(traderEventPayload({ riskScore: 9, price: { internal: true }, volume: 1 })).toEqual({
      volume: 1,
    });
    expect(traderEventPayload(null)).toEqual({});
    expect(traderEventPayload(['volume'])).toEqual({});
  });
});
