import type { OrderEventRow } from './queries';

/**
 * An order's trail in a trader's words.
 *
 * The event types are the order state machine's (`OrderEventType` in the
 * schema). Each becomes a short phrase, and the payload's facts follow it in
 * a fixed order, as the server wrote them — nothing here computes a price.
 * A type this table does not know is shown as spelled, not dropped: a trail
 * with a hole in it reads as a trail with nothing missing.
 */
export const ORDER_EVENT_LABEL: Record<string, string> = {
  CREATED: 'Placed',
  VALIDATED: 'Checked',
  ACCEPTED: 'Accepted',
  UNCONFIRMED: 'Awaiting the venue’s answer',
  REJECTED: 'Refused',
  TRIGGERED: 'Triggered',
  PARTIALLY_FILLED: 'Partly filled',
  FILLED: 'Filled',
  MODIFY_REQUESTED: 'Change requested',
  MODIFIED: 'Changed',
  CANCEL_REQUESTED: 'Cancel requested',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

const FACTS: ReadonlyArray<readonly [key: string, label: string]> = [
  ['volume', 'volume'],
  ['filledVolume', 'filled'],
  ['price', 'price'],
  ['averagePrice', 'average'],
  ['restingPrice', 'resting at'],
  ['stopPrice', 'stop'],
  ['stopLoss', 'SL'],
  ['takeProfit', 'TP'],
  ['bid', 'bid'],
  ['ask', 'ask'],
  ['timeInForce', 'time in force'],
  ['expiresAt', 'expires'],
  ['previousPrice', 'was price'],
  ['previousStopPrice', 'was stop'],
  ['previousStopLoss', 'was SL'],
  ['previousTakeProfit', 'was TP'],
  ['previousVolume', 'was volume'],
];

export interface TrailLine {
  readonly label: string;
  readonly facts: string;
  /** Why, when the server said: a refusal, a cancellation, a system change. */
  readonly reason: string | null;
  readonly at: string;
}

export function trailLines(events: readonly OrderEventRow[]): TrailLine[] {
  return events.map((event) => {
    const payload = event.payload ?? {};
    const facts = FACTS.flatMap(([key, label]) => {
      const value = payload[key];
      return value === undefined || value === null || value === ''
        ? []
        : [`${label} ${String(value)}`];
    }).join(' · ');
    const by = typeof payload['by'] === 'string' ? `by ${payload['by'].toLowerCase()}` : null;
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null;
    return {
      label: ORDER_EVENT_LABEL[event.type] ?? event.type,
      facts: [facts, by].filter((part) => part !== null && part !== '').join(' · '),
      reason,
      at: event.at,
    };
  });
}
