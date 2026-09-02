import { Money } from '@tp/financial-core';

/**
 * What a deployment allows, and what a person has already used.
 *
 * Everything here is a decimal string on the way in and a `Money` inside, for
 * the reason every other money field on the platform is: a withdrawal limit
 * compared as a float is a limit that is off by a cent on the day it matters.
 */
export interface WithdrawalPolicy {
  /** Smallest request that will be taken. A withdrawal of a cent costs more to pay than it moves. */
  readonly minimum: string;
  /** Largest single request. */
  readonly maximum: string;
  /** Largest sum of requests in any rolling twenty-four hours; null means no cap. */
  readonly dailyLimit: string | null;
  /** Hours that must pass after one request before another; 0 means none. */
  readonly cooldownHours: number;
  /** Whether a verified identity is required before any of the above is even considered. */
  readonly requireVerifiedIdentity: boolean;
}

export interface WithdrawalHistory {
  /** Requests in the last twenty-four hours that still count — see COUNTS_TOWARD_LIMITS. */
  readonly requestedToday: string;
  /** When the most recent request that still counts was made; null if none. */
  readonly lastRequestedAt: Date | null;
}

export interface Applicant {
  readonly identityVerified: boolean;
  readonly available: string;
}

export type Refusal =
  | { readonly reason: 'IDENTITY_NOT_VERIFIED' }
  | { readonly reason: 'NOT_POSITIVE' }
  | { readonly reason: 'BELOW_MINIMUM'; readonly minimum: string }
  | { readonly reason: 'ABOVE_MAXIMUM'; readonly maximum: string }
  | { readonly reason: 'INSUFFICIENT_FUNDS'; readonly available: string }
  | {
      readonly reason: 'DAILY_LIMIT';
      readonly dailyLimit: string;
      readonly alreadyRequested: string;
      readonly remaining: string;
    }
  | { readonly reason: 'COOLDOWN'; readonly until: Date };

/**
 * Every reason a request would be refused, all at once.
 *
 * Not the first reason. A person told "below the minimum" who then raises the
 * amount and is told "above your daily limit" has been sent round a loop the
 * platform could have avoided by reading the list out in one go. The service
 * turns the list into one message; the order here is the order it reads best.
 *
 * Identity comes first and is the only reason that makes the others moot: a
 * person who is not verified is not being told how much they could withdraw
 * if they were.
 */
export function refusalsFor(input: {
  readonly amount: string;
  readonly currency: string;
  readonly policy: WithdrawalPolicy;
  readonly applicant: Applicant;
  readonly history: WithdrawalHistory;
  readonly now?: Date;
}): Refusal[] {
  const { policy, applicant, history, currency } = input;
  const now = input.now ?? new Date();

  if (policy.requireVerifiedIdentity && !applicant.identityVerified) {
    return [{ reason: 'IDENTITY_NOT_VERIFIED' }];
  }

  const amount = Money.of(input.amount, currency);
  const refusals: Refusal[] = [];

  if (!amount.isPositive()) {
    return [{ reason: 'NOT_POSITIVE' }];
  }

  const minimum = Money.of(policy.minimum, currency);
  if (amount.lt(minimum)) refusals.push({ reason: 'BELOW_MINIMUM', minimum: minimum.toString() });

  const maximum = Money.of(policy.maximum, currency);
  if (amount.gt(maximum)) refusals.push({ reason: 'ABOVE_MAXIMUM', maximum: maximum.toString() });

  const available = Money.of(applicant.available, currency);
  if (amount.gt(available)) {
    refusals.push({ reason: 'INSUFFICIENT_FUNDS', available: available.toString() });
  }

  if (policy.dailyLimit !== null) {
    const cap = Money.of(policy.dailyLimit, currency);
    const used = Money.of(history.requestedToday, currency);
    const remaining = cap.minus(used);
    if (amount.gt(remaining)) {
      refusals.push({
        reason: 'DAILY_LIMIT',
        dailyLimit: cap.toString(),
        alreadyRequested: used.toString(),
        remaining: (remaining.isPositive() ? remaining : Money.of('0', currency)).toString(),
      });
    }
  }

  if (policy.cooldownHours > 0 && history.lastRequestedAt !== null) {
    const until = new Date(history.lastRequestedAt.getTime() + policy.cooldownHours * 3_600_000);
    if (until > now) refusals.push({ reason: 'COOLDOWN', until });
  }

  return refusals;
}

/**
 * Whether a request needs a person to say yes.
 *
 * A deployment may auto-approve below a threshold — small, routine withdrawals
 * of money the person plainly has. Everything at or above it, and everything
 * when no threshold is set, waits for somebody holding `withdrawals.review`.
 *
 * Auto-approval is approval, not payment. An auto-approved request still sits
 * in the queue until a person starts the payout and later confirms it, because
 * there is no automated rail here to start one with.
 */
export function needsHumanApproval(
  amount: string,
  currency: string,
  autoApproveBelow: string | null,
): boolean {
  if (autoApproveBelow === null) return true;
  return !Money.of(amount, currency).lt(Money.of(autoApproveBelow, currency));
}
