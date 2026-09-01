import { describe, expect, it } from 'vitest';
import { PaymentStatus, TERMINAL, isTerminal, react } from './state';

const ALL = Object.values(PaymentStatus);

/**
 * The rule the plan gave this phase: a failed payment must never create funds.
 *
 * Everything here is about the moment a provider reports something. Money is
 * credited on exactly one transition — into SUCCEEDED — so the question of when
 * that transition is allowed is the question of when money can appear.
 */
describe('reacting to what a provider reports', () => {
  it('advances through the ordinary path', () => {
    expect(react(PaymentStatus.REQUIRES_ACTION, PaymentStatus.PROCESSING)).toEqual({
      kind: 'apply',
      to: PaymentStatus.PROCESSING,
    });
    expect(react(PaymentStatus.PROCESSING, PaymentStatus.SUCCEEDED)).toEqual({
      kind: 'apply',
      to: PaymentStatus.SUCCEEDED,
    });
  });

  it('allows a provider to settle without ever saying processing', () => {
    // Several do. A payment that is taken and settled in one call reports
    // succeeded straight away, and refusing that would strand it.
    expect(react(PaymentStatus.REQUIRES_ACTION, PaymentStatus.SUCCEEDED).kind).toBe('apply');
  });

  /**
   * Webhooks are re-delivered and arrive out of order. Both are ordinary and
   * neither is a problem: the state is already at or past what was reported.
   */
  it('ignores a re-delivery', () => {
    for (const status of ALL) {
      expect(react(status, status)).toMatchObject({ kind: 'ignore' });
    }
  });

  it('ignores a state that arrives late', () => {
    expect(react(PaymentStatus.SUCCEEDED, PaymentStatus.PROCESSING)).toMatchObject({
      kind: 'ignore',
    });
    expect(react(PaymentStatus.PROCESSING, PaymentStatus.REQUIRES_ACTION)).toMatchObject({
      kind: 'ignore',
    });
  });

  /**
   * The dangerous one, and the reason `react` returns three outcomes rather
   * than a boolean.
   *
   * A `failed` after a `succeeded` must not quietly take the money back — a
   * genuine reversal is a chargeback, which is a separate movement with its own
   * accounting — and it must not be swallowed either, because if it is real then
   * money has left and somebody needs to know within minutes.
   */
  it('raises an alarm when one terminal state contradicts another', () => {
    const reaction = react(PaymentStatus.SUCCEEDED, PaymentStatus.FAILED);
    expect(reaction.kind).toBe('alarm');
    expect(reaction.kind === 'alarm' ? reaction.why : '').toMatch(/chargeback/i);
  });

  it.each([
    [PaymentStatus.SUCCEEDED, PaymentStatus.CANCELLED],
    [PaymentStatus.FAILED, PaymentStatus.SUCCEEDED],
    [PaymentStatus.CANCELLED, PaymentStatus.SUCCEEDED],
    [PaymentStatus.EXPIRED, PaymentStatus.SUCCEEDED],
  ])('raises an alarm for %s → %s', (from, reported) => {
    expect(react(from, reported).kind).toBe('alarm');
  });

  /**
   * Nothing leaves a terminal state by being *applied*. That is what makes
   * "credited exactly once" a property of the machine rather than of the
   * caller's care.
   */
  it('never applies anything to a settled payment', () => {
    for (const from of TERMINAL) {
      for (const reported of ALL) {
        expect(react(from, reported).kind).not.toBe('apply');
      }
    }
  });

  it('knows which states are terminal', () => {
    expect(TERMINAL.every(isTerminal)).toBe(true);
    expect(isTerminal(PaymentStatus.REQUIRES_ACTION)).toBe(false);
    expect(isTerminal(PaymentStatus.PROCESSING)).toBe(false);
  });

  /**
   * Every state is either terminal or has somewhere to go. A state with no exit
   * that is not terminal is a payment nobody can finish, and it would sit in a
   * queue forever looking like a bug in the provider.
   */
  it('leaves no state stuck', () => {
    for (const status of ALL) {
      const reachable = ALL.some((other) => react(status, other).kind === 'apply');
      expect(reachable || isTerminal(status)).toBe(true);
    }
  });

  it('can reach SUCCEEDED from every non-terminal state', () => {
    for (const status of ALL) {
      if (isTerminal(status)) continue;
      expect(react(status, PaymentStatus.SUCCEEDED).kind).toBe('apply');
    }
  });
});
