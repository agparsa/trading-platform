import { describe, expect, it } from 'vitest';
import {
  WithdrawalStatus,
  canTransition,
  cancellableByRequester,
  isTerminal,
  releasesHold,
} from './state';

const ALL = Object.values(WithdrawalStatus);

describe('the withdrawal state machine', () => {
  it('lets the person withdraw the request only while nobody has decided', () => {
    expect(cancellableByRequester(WithdrawalStatus.REQUESTED)).toBe(true);
    expect(cancellableByRequester(WithdrawalStatus.UNDER_REVIEW)).toBe(true);
    for (const later of [
      WithdrawalStatus.APPROVED,
      WithdrawalStatus.PROCESSING,
      WithdrawalStatus.PAID,
    ]) {
      expect(cancellableByRequester(later)).toBe(false);
      expect(canTransition(later, WithdrawalStatus.CANCELLED)).toBe(false);
    }
    // And the table agrees with the rule.
    expect(canTransition(WithdrawalStatus.REQUESTED, WithdrawalStatus.CANCELLED)).toBe(true);
    expect(canTransition(WithdrawalStatus.UNDER_REVIEW, WithdrawalStatus.CANCELLED)).toBe(true);
  });

  it('lets an approval be taken back until the payout has started, and not after', () => {
    expect(canTransition(WithdrawalStatus.APPROVED, WithdrawalStatus.REJECTED)).toBe(true);
    expect(canTransition(WithdrawalStatus.PROCESSING, WithdrawalStatus.REJECTED)).toBe(false);
    expect(canTransition(WithdrawalStatus.PROCESSING, WithdrawalStatus.PAID)).toBe(true);
    expect(canTransition(WithdrawalStatus.PROCESSING, WithdrawalStatus.FAILED)).toBe(true);
  });

  it('never pays something that was not approved', () => {
    for (const from of ALL) {
      if (from === WithdrawalStatus.PROCESSING) continue;
      expect(canTransition(from, WithdrawalStatus.PAID)).toBe(false);
    }
    for (const from of ALL) {
      expect(canTransition(from, WithdrawalStatus.PROCESSING)).toBe(
        from === WithdrawalStatus.APPROVED,
      );
    }
  });

  it('knows which endings give the money back', () => {
    expect(releasesHold(WithdrawalStatus.REJECTED)).toBe(true);
    expect(releasesHold(WithdrawalStatus.CANCELLED)).toBe(true);
    expect(releasesHold(WithdrawalStatus.FAILED)).toBe(true);
    expect(releasesHold(WithdrawalStatus.PAID)).toBe(false);
    for (const status of ALL) {
      if (releasesHold(status)) expect(isTerminal(status)).toBe(true);
    }
  });

  it('leaves nothing after a terminal state', () => {
    for (const from of [
      WithdrawalStatus.PAID,
      WithdrawalStatus.REJECTED,
      WithdrawalStatus.CANCELLED,
      WithdrawalStatus.FAILED,
    ]) {
      for (const to of ALL) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('refuses every self-transition', () => {
    for (const status of ALL) expect(canTransition(status, status)).toBe(false);
  });
});
