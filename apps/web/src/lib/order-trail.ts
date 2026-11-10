import type { OrderEventRow } from './queries';
import { translate, wordsFor, type MessageKey } from './messages';

/** A translator, as `useT()` returns it; English when none is given. */
export type Translate = (
  key: MessageKey,
  vars?: Readonly<Record<string, string | number>>,
) => string;

const ENGLISH: Translate = (key, vars) => translate('en', key, vars);

/**
 * An order's trail in a trader's words.
 *
 * The event types are the order state machine's (`OrderEventType` in the
 * schema). Each becomes a short phrase, and the payload's facts follow it in
 * a fixed order, as the server wrote them — nothing here computes a price.
 * A type this table does not know is shown as spelled, not dropped: a trail
 * with a hole in it reads as a trail with nothing missing.
 */
export const ORDER_EVENT_LABEL: Record<string, MessageKey> = {
  CREATED: 'trail.event.CREATED',
  VALIDATED: 'trail.event.VALIDATED',
  ACCEPTED: 'trail.event.ACCEPTED',
  UNCONFIRMED: 'trail.event.UNCONFIRMED',
  REJECTED: 'trail.event.REJECTED',
  TRIGGERED: 'trail.event.TRIGGERED',
  PARTIALLY_FILLED: 'trail.event.PARTIALLY_FILLED',
  FILLED: 'trail.event.FILLED',
  MODIFY_REQUESTED: 'trail.event.MODIFY_REQUESTED',
  MODIFIED: 'trail.event.MODIFIED',
  CANCEL_REQUESTED: 'trail.event.CANCEL_REQUESTED',
  CANCELLED: 'trail.event.CANCELLED',
  EXPIRED: 'trail.event.EXPIRED',
};

const FACTS: ReadonlyArray<readonly [key: string, label: MessageKey]> = [
  ['volume', 'trail.fact.volume'],
  ['filledVolume', 'trail.fact.filledVolume'],
  ['price', 'trail.fact.price'],
  ['averagePrice', 'trail.fact.averagePrice'],
  ['restingPrice', 'trail.fact.restingPrice'],
  ['stopPrice', 'trail.fact.stopPrice'],
  ['stopLoss', 'trail.fact.stopLoss'],
  ['takeProfit', 'trail.fact.takeProfit'],
  ['bid', 'trail.fact.bid'],
  ['ask', 'trail.fact.ask'],
  ['timeInForce', 'trail.fact.timeInForce'],
  ['expiresAt', 'trail.fact.expiresAt'],
  ['previousPrice', 'trail.fact.previousPrice'],
  ['previousStopPrice', 'trail.fact.previousStopPrice'],
  ['previousStopLoss', 'trail.fact.previousStopLoss'],
  ['previousTakeProfit', 'trail.fact.previousTakeProfit'],
  ['previousVolume', 'trail.fact.previousVolume'],
];

export interface TrailLine {
  readonly label: string;
  readonly facts: string;
  /** Why, when the server said: a refusal, a cancellation, a system change. */
  readonly reason: string | null;
  readonly at: string;
}

export function trailLines(events: readonly OrderEventRow[], t: Translate = ENGLISH): TrailLine[] {
  return events.map((event) => {
    const payload = event.payload ?? {};
    const facts = FACTS.flatMap(([key, label]) => {
      const value = payload[key];
      return value === undefined || value === null || value === ''
        ? []
        : [`${t(label)} ${t('trail.value', { value: String(value) })}`];
    }).join(' · ');
    const by =
      typeof payload['by'] === 'string'
        ? t('trail.by', { who: payload['by'].toLowerCase() })
        : null;
    const reason = typeof payload['reason'] === 'string' ? payload['reason'] : null;
    return {
      label: wordsFor(ORDER_EVENT_LABEL, event.type, t),
      facts: [facts, by].filter((part) => part !== null && part !== '').join(' · '),
      reason,
      at: event.at,
    };
  });
}
