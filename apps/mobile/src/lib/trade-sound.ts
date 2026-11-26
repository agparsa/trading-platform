import { NotificationCategory } from '@tp/shared-types';

/**
 * Which trading sound a socket frame calls for, when this phone has no push
 * route to hear it by: a position opened, closed, stopped out or taken at its
 * target. `null` for every other frame.
 *
 * Keyed by the occurrence (`position:<id>:opened|closed`) rather than the
 * frame, so the app's own "your order filled" and the frame for the same fill
 * are one event to the deduplicating handler, and sound once.
 */
export function frameSound(
  event: string,
  data: unknown,
): { eventId: string; category: NotificationCategory } | null {
  if (data === null || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const positionId =
    typeof record['positionId'] === 'string'
      ? record['positionId']
      : typeof record['id'] === 'string'
        ? record['id']
        : null;
  if (positionId === null) return null;
  if (event === 'position.created') {
    return { eventId: openedKey(positionId), category: NotificationCategory.TRADE_OPENED };
  }
  if (event === 'position.closed') {
    const reason = record['reason'];
    return {
      eventId: closedKey(positionId),
      category:
        reason === 'STOP_LOSS' || reason === 'TRAILING_STOP'
          ? NotificationCategory.STOP_LOSS
          : reason === 'TAKE_PROFIT'
            ? NotificationCategory.TAKE_PROFIT
            : NotificationCategory.TRADE_CLOSED,
    };
  }
  return null;
}

export const openedKey = (positionId: string): string => `position:${positionId}:opened`;
export const closedKey = (positionId: string): string => `position:${positionId}:closed`;
