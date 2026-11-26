import { describe, expect, it } from 'vitest';
import { NotificationCategory } from '@tp/shared-types';
import { frameSound, openedKey } from './trade-sound';

describe('the sound a frame calls for', () => {
  it('opens and closes, keyed by the position so the app’s own fill is the same event', () => {
    expect(frameSound('position.created', { positionId: 'p1' })).toEqual({
      eventId: openedKey('p1'),
      category: NotificationCategory.TRADE_OPENED,
    });
    expect(frameSound('position.closed', { positionId: 'p1', reason: 'MANUAL' })?.category).toBe(
      NotificationCategory.TRADE_CLOSED,
    );
  });

  it('gives a stop-out and a target their own sounds', () => {
    expect(frameSound('position.closed', { id: 'p1', reason: 'STOP_LOSS' })?.category).toBe(
      NotificationCategory.STOP_LOSS,
    );
    expect(frameSound('position.closed', { id: 'p1', reason: 'TRAILING_STOP' })?.category).toBe(
      NotificationCategory.STOP_LOSS,
    );
    expect(frameSound('position.closed', { id: 'p1', reason: 'TAKE_PROFIT' })?.category).toBe(
      NotificationCategory.TAKE_PROFIT,
    );
  });

  it('is silent for anything else, or a frame that names no position', () => {
    expect(frameSound('position.updated', { positionId: 'p1' })).toBeNull();
    expect(frameSound('position.created', {})).toBeNull();
    expect(frameSound('position.created', null)).toBeNull();
  });
});
