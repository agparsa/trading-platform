/**
 * What a withdrawal can be, and what it may become.
 *
 * ## The one fact every state agrees on
 *
 * The money is **held from the moment of the request**. A withdrawal debits the
 * wallet when it is asked for, not when it is paid, so that the balance a person
 * sees — and the balance a transfer into a trading account is judged against —
 * is what they can actually still use. Every state after REQUESTED is about
 * what happens to money that has already left the wallet: it goes out of the
 * platform (PAID), or it comes back (REJECTED, CANCELLED, FAILED).
 */
export const WithdrawalStatus = {
  /** Asked for; the wallet has been debited; nobody has looked yet. */
  REQUESTED: 'REQUESTED',
  /** An operator has it open. */
  UNDER_REVIEW: 'UNDER_REVIEW',
  /** Somebody with the capability said yes. Money still on the platform. */
  APPROVED: 'APPROVED',
  /** A payout has been started — a transfer sent, a rail instructed. */
  PROCESSING: 'PROCESSING',
  /** Terminal. The money is gone and somebody said so. */
  PAID: 'PAID',
  /** Terminal. Refused, with a reason the person is shown; the hold is released. */
  REJECTED: 'REJECTED',
  /** Terminal. Withdrawn by the person before approval; the hold is released. */
  CANCELLED: 'CANCELLED',
  /** Terminal. The payout could not be completed; the hold is released. */
  FAILED: 'FAILED',
} as const;
export type WithdrawalStatus = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

const NEXT: Readonly<Record<WithdrawalStatus, readonly WithdrawalStatus[]>> = {
  [WithdrawalStatus.REQUESTED]: [
    WithdrawalStatus.UNDER_REVIEW,
    WithdrawalStatus.APPROVED,
    WithdrawalStatus.REJECTED,
    WithdrawalStatus.CANCELLED,
  ],
  [WithdrawalStatus.UNDER_REVIEW]: [
    WithdrawalStatus.APPROVED,
    WithdrawalStatus.REJECTED,
    WithdrawalStatus.REQUESTED,
    // Still the person's to withdraw: nothing has been decided.
    WithdrawalStatus.CANCELLED,
  ],
  /**
   * An approved withdrawal can still be rejected — a reviewer who approved at
   * nine and learns something at ten must be able to stop it before it is
   * paid. It cannot be cancelled by the person: their say ended at approval.
   */
  [WithdrawalStatus.APPROVED]: [WithdrawalStatus.PROCESSING, WithdrawalStatus.REJECTED],
  /**
   * Once a payout has been started there is no rejecting it; the money may
   * already have left. It is paid, or it failed and came back.
   */
  [WithdrawalStatus.PROCESSING]: [WithdrawalStatus.PAID, WithdrawalStatus.FAILED],
  [WithdrawalStatus.PAID]: [],
  [WithdrawalStatus.REJECTED]: [],
  [WithdrawalStatus.CANCELLED]: [],
  [WithdrawalStatus.FAILED]: [],
};

export function canTransition(from: WithdrawalStatus, to: WithdrawalStatus): boolean {
  return NEXT[from].includes(to);
}

export const TERMINAL: readonly WithdrawalStatus[] = [
  WithdrawalStatus.PAID,
  WithdrawalStatus.REJECTED,
  WithdrawalStatus.CANCELLED,
  WithdrawalStatus.FAILED,
];

export function isTerminal(status: WithdrawalStatus): boolean {
  return TERMINAL.includes(status);
}

/** Terminal states in which the held money came back to the wallet. */
export const RELEASING: readonly WithdrawalStatus[] = [
  WithdrawalStatus.REJECTED,
  WithdrawalStatus.CANCELLED,
  WithdrawalStatus.FAILED,
];

export function releasesHold(status: WithdrawalStatus): boolean {
  return RELEASING.includes(status);
}

/** States that still count against a person's daily allowance. */
export const COUNTS_TOWARD_LIMITS: readonly WithdrawalStatus[] = [
  WithdrawalStatus.REQUESTED,
  WithdrawalStatus.UNDER_REVIEW,
  WithdrawalStatus.APPROVED,
  WithdrawalStatus.PROCESSING,
  WithdrawalStatus.PAID,
];

/** States the person may still withdraw the request from. */
export function cancellableByRequester(status: WithdrawalStatus): boolean {
  return status === WithdrawalStatus.REQUESTED || status === WithdrawalStatus.UNDER_REVIEW;
}
