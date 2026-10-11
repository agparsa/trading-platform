import { describe, expect, it } from 'vitest';
import { orderTypeLabel, restingPriceLine } from './pending-order-line';

describe('a resting order, in one line', () => {
  it('says where a limit or a stop waits', () => {
    expect(restingPriceLine({ type: 'LIMIT', price: '4550' })).toBe('at 4550');
    expect(restingPriceLine({ type: 'STOP', price: '4600', stopPrice: null })).toBe('at 4600');
  });

  it('names both prices of a stop-limit waiting for its stop', () => {
    expect(
      restingPriceLine({ type: 'STOP_LIMIT', price: '4602', stopPrice: '4600', activatedAt: null }),
    ).toBe('stop 4600, then limit 4602');
  });

  it('says a stop-limit whose stop was reached is resting at its limit', () => {
    expect(
      restingPriceLine({
        type: 'STOP_LIMIT',
        price: '4602',
        stopPrice: '4600',
        activatedAt: '2026-10-10T18:00:00.000Z',
      }),
    ).toBe('stop reached · resting at limit 4602');
  });

  it('labels the type for people', () => {
    expect(orderTypeLabel('STOP_LIMIT')).toBe('STOP LMT');
    expect(orderTypeLabel('LIMIT')).toBe('LIMIT');
  });
});
