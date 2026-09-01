/**
 * What a payment can be, and what it may become.
 *
 * The states are written out rather than inferred from a provider's vocabulary,
 * because every provider has its own and the platform must not learn a new one
 * each time somebody signs a different contract. An adapter's job is to map its
 * provider's language onto this.
 */
export const PaymentStatus = {
  /** Created. The payer still has something to do — pay at a bank, complete a redirect. */
  REQUIRES_ACTION: 'REQUIRES_ACTION',
  /** The provider says it has the money and is settling. */
  PROCESSING: 'PROCESSING',
  /** Terminal. Funds have been credited, exactly once. */
  SUCCEEDED: 'SUCCEEDED',
  /** Terminal. The provider refused, or the payer never paid. */
  FAILED: 'FAILED',
  /** Terminal. Withdrawn by the payer or by an operator. */
  CANCELLED: 'CANCELLED',
  /** Terminal. Nobody acted in time. */
  EXPIRED: 'EXPIRED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

const NEXT: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  [PaymentStatus.REQUIRES_ACTION]: [
    PaymentStatus.PROCESSING,
    PaymentStatus.SUCCEEDED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED,
  ],
  [PaymentStatus.PROCESSING]: [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED],
  [PaymentStatus.SUCCEEDED]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CANCELLED]: [],
  [PaymentStatus.EXPIRED]: [],
};

export const TERMINAL: readonly PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.FAILED,
  PaymentStatus.CANCELLED,
  PaymentStatus.EXPIRED,
];

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * What to do with a status a provider has just reported.
 *
 * Not a boolean, because there are three outcomes and collapsing them loses the
 * one that matters.
 *
 *   - **apply** — a real advance; write it.
 *   - **ignore** — the same or an earlier state, which a provider will send.
 *     Webhooks arrive out of order and are re-delivered; `processing` after
 *     `succeeded` is ordinary and means nothing has changed.
 *   - **alarm** — a *contradiction*: something terminal reported after
 *     something else terminal. `failed` after `succeeded` is the dangerous one.
 *     It must not silently take money back — a genuine reversal is a chargeback,
 *     which is its own event with its own accounting — and it must not be
 *     swallowed either, because if it is real the money is gone.
 */
export type Reaction =
  | { readonly kind: 'apply'; readonly to: PaymentStatus }
  | { readonly kind: 'ignore'; readonly why: string }
  | { readonly kind: 'alarm'; readonly why: string };

export function react(from: PaymentStatus, reported: PaymentStatus): Reaction {
  if (from === reported) {
    return { kind: 'ignore', why: `already ${reported}` };
  }
  if (NEXT[from].includes(reported)) {
    return { kind: 'apply', to: reported };
  }
  if (isTerminal(from) && isTerminal(reported)) {
    return {
      kind: 'alarm',
      why:
        `reported ${reported} for a payment that is already ${from}. ` +
        'A settled payment does not un-settle; if this is a reversal it is a chargeback, ' +
        'which is a separate movement with its own record.',
    };
  }
  return {
    kind: 'ignore',
    why: `${reported} does not follow ${from}; webhooks arrive out of order`,
  };
}
