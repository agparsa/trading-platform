import { describe, expect, it } from 'vitest';
import { orderLogLines } from './order-log';
import type { OrderLogRow } from './queries';

const row = (id: string, type: string, extra: Partial<OrderLogRow> = {}): OrderLogRow => ({
  id,
  orderId: 'o1',
  symbol: 'XAUUSD',
  side: 'BUY',
  orderType: 'STOP_LIMIT',
  type,
  fromStatus: null,
  toStatus: 'FILLED',
  payload: {},
  at: '2026-10-29T08:00:00.000Z',
  ...extra,
});

describe('the order log', () => {
  it("reads each event in the trail's words, with its order named", () => {
    const [line] = orderLogLines([
      { events: [row('e1', 'FILLED', { payload: { price: '4583.72', volume: '1' } })] },
    ]);
    expect(line).toMatchObject({
      label: 'Filled',
      facts: 'volume 1 · price 4583.72',
      symbol: 'XAUUSD',
      side: 'BUY',
      orderType: 'stop limit',
    });
  });

  it('shows a row once when a new event pushes it onto the next page too', () => {
    const lines = orderLogLines([
      { events: [row('e3', 'CANCELLED'), row('e2', 'ACCEPTED')] },
      { events: [row('e2', 'ACCEPTED'), row('e1', 'CREATED')] },
    ]);
    expect(lines.map((line) => line.id)).toEqual(['e3', 'e2', 'e1']);
    expect(lines.map((line) => line.label)).toEqual(['Cancelled', 'Accepted', 'Placed']);
  });

  it('is empty before anything has loaded', () => {
    expect(orderLogLines(undefined)).toEqual([]);
  });
});
