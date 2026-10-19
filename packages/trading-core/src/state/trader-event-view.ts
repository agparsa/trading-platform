/**
 * What of an order event's payload its owner sees.
 *
 * The payload is written for the record — support, reconciliation, recovery —
 * and an order executed at a venue carries the platform's side of that
 * arrangement: which broker connection it went through (`venue`,
 * `connectionId`), the venue's names for the instrument and the account
 * (`externalSymbol`, `externalAccountId`) and the ids the two systems
 * exchanged (`clientOrderId`, `externalOrderId`). None of it is the trader's,
 * and `GET /orders/:id/events` returned all of it.
 *
 * So the trader's view is an allowlist, not a denylist: a key added to a
 * payload later is hidden until somebody decides a trader should read it.
 * The admin console reads the full payload through its own route.
 */
export const TRADER_EVENT_KEYS = [
  'volume',
  'filledVolume',
  'price',
  'averagePrice',
  'restingPrice',
  'stopPrice',
  'stopLoss',
  'takeProfit',
  'bid',
  'ask',
  'reason',
  'by',
  'type',
  'timeInForce',
  'expiresAt',
  'symbol',
  'previousPrice',
  'previousStopPrice',
  'previousStopLoss',
  'previousTakeProfit',
  'previousVolume',
] as const;

const VISIBLE: ReadonlySet<string> = new Set(TRADER_EVENT_KEYS);

export function traderEventPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!VISIBLE.has(key)) continue;
    // Only scalar values: a nested object is somebody's internal structure.
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}
