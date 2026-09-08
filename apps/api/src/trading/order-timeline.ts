/**
 * Where an order spent its time (§50).
 *
 * The end-to-end number — `tp_order_ack_seconds` — says a submission took 300ms.
 * It does not say whether that was the risk valuation, the venue, or the row
 * lock, and those are three different incidents with three different fixes. The
 * timeline is what turns "orders are slow" into a place to look.
 *
 * ## Stages
 *
 * | Stage       | Ends when                                                     |
 * | ----------- | ------------------------------------------------------------- |
 * | `received`  | The request reached the order path.                            |
 * | `validated` | Instrument, session, account status, throttle and volume pass. |
 * | `priced`    | A fresh quote, the conversion rate and the margin are known.   |
 * | `accepted`  | The order row exists inside its transaction.                   |
 * | `executed`  | The fill — or the refusal — is written.                        |
 *
 * There is deliberately no `responded` stage here. The time between the last
 * write and the bytes leaving the process is the HTTP layer's, and it is
 * already `tp_http_request_duration_seconds`; adding it would be the same
 * milliseconds counted twice under two names.
 */
export const ORDER_STAGES = ['received', 'validated', 'priced', 'accepted', 'executed'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

export interface OrderSpan {
  readonly stage: OrderStage;
  /** Milliseconds spent in this stage, i.e. since the previous mark. */
  readonly ms: number;
}

/**
 * Marks the stages of one order.
 *
 * Uses the wall clock rather than a monotonic timer on purpose: these numbers
 * end up in a log line beside a timestamp, and an operator comparing them to a
 * venue's log needs them on the same clock the rest of the record is on. The
 * error a clock step could introduce is smaller than the thing being measured
 * is useful for.
 */
export class OrderTimeline {
  private readonly marks: Array<{ stage: OrderStage; at: number }> = [];
  private last: number;

  constructor(readonly startedAt: number = Date.now()) {
    this.last = startedAt;
  }

  mark(stage: OrderStage, at: number = Date.now()): void {
    this.marks.push({ stage, at });
    this.last = at;
  }

  /** How long each marked stage took. Unmarked stages are simply absent. */
  spans(): readonly OrderSpan[] {
    let previous = this.startedAt;
    return this.marks.map(({ stage, at }) => {
      const span = { stage, ms: Math.max(0, at - previous) };
      previous = at;
      return span;
    });
  }

  /** Total across the stages that were marked. */
  totalMs(): number {
    return Math.max(0, this.last - this.startedAt);
  }

  /** A flat object for a structured log line: `{ received: 2, validated: 18 }`. */
  toLog(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { stage, ms } of this.spans()) out[stage] = ms;
    return out;
  }
}

/**
 * How far ahead of the server a client believes it is.
 *
 * Recorded, never trusted. A browser's clock is whatever the person set it to,
 * so this cannot be used to decide anything about an order — but a population
 * of clients whose skew suddenly changes together is a real signal, and
 * `docs/anti-fraud.md` names it as one. Returns `null` when the client said
 * nothing, which is the normal case.
 */
export function clientSkewMs(clientSentAt: number | null, receivedAt: number): number | null {
  if (clientSentAt === null || !Number.isFinite(clientSentAt)) return null;
  return receivedAt - clientSentAt;
}
