import { describe, expect, it } from 'vitest';
import { needsHumanApproval, refusalsFor, type WithdrawalPolicy } from './limits';

const policy: WithdrawalPolicy = {
  minimum: '10',
  maximum: '5000',
  dailyLimit: '8000',
  cooldownHours: 1,
  requireVerifiedIdentity: true,
};

const now = new Date('2026-09-01T12:00:00Z');

const ask = (
  amount: string,
  over: Partial<{
    policy: Partial<WithdrawalPolicy>;
    verified: boolean;
    available: string;
    requestedToday: string;
    lastRequestedAt: Date | null;
  }> = {},
) =>
  refusalsFor({
    amount,
    currency: 'USD',
    policy: { ...policy, ...over.policy },
    applicant: { identityVerified: over.verified ?? true, available: over.available ?? '10000' },
    history: {
      requestedToday: over.requestedToday ?? '0',
      lastRequestedAt: over.lastRequestedAt ?? null,
    },
    now,
  });

describe('why a withdrawal would be refused', () => {
  it('says nothing about an ordinary request', () => {
    expect(ask('100')).toEqual([]);
  });

  it('puts identity first and stops there', () => {
    // Everything else about this request is also wrong; none of it is said.
    expect(ask('0.01', { verified: false, available: '0' })).toEqual([
      { reason: 'IDENTITY_NOT_VERIFIED' },
    ]);
  });

  it('does not ask for identity when the deployment does not', () => {
    expect(ask('100', { verified: false, policy: { requireVerifiedIdentity: false } })).toEqual([]);
  });

  it('refuses nothing and less than nothing', () => {
    expect(ask('0')).toEqual([{ reason: 'NOT_POSITIVE' }]);
    expect(ask('-5')).toEqual([{ reason: 'NOT_POSITIVE' }]);
  });

  it('names every limit crossed, at once', () => {
    const refusals = ask('9000', { available: '100', requestedToday: '7500' });
    expect(refusals.map((one) => one.reason).sort()).toEqual([
      'ABOVE_MAXIMUM',
      'DAILY_LIMIT',
      'INSUFFICIENT_FUNDS',
    ]);
  });

  it('is inclusive at both ends of the size band', () => {
    expect(ask('10')).toEqual([]);
    expect(ask('9.99')).toEqual([{ reason: 'BELOW_MINIMUM', minimum: '10.00' }]);
    expect(ask('5000')).toEqual([]);
    expect(ask('5000.01')).toEqual([{ reason: 'ABOVE_MAXIMUM', maximum: '5000.00' }]);
  });

  it('measures the daily cap against what was already requested, to the cent', () => {
    expect(ask('500', { requestedToday: '7500' })).toEqual([]);
    expect(ask('500.01', { requestedToday: '7500' })).toEqual([
      {
        reason: 'DAILY_LIMIT',
        dailyLimit: '8000.00',
        alreadyRequested: '7500.00',
        remaining: '500.00',
      },
    ]);
  });

  it('reports zero remaining rather than a negative number', () => {
    const [refusal] = ask('10', { requestedToday: '9000' });
    expect(refusal).toMatchObject({ reason: 'DAILY_LIMIT', remaining: '0.00' });
  });

  it('has no daily cap when none is configured', () => {
    expect(ask('5000', { policy: { dailyLimit: null }, requestedToday: '1000000' })).toEqual([]);
  });

  it('holds the cooldown until the hour is up, and not a second longer', () => {
    const justNow = new Date(now.getTime() - 59 * 60_000);
    expect(ask('100', { lastRequestedAt: justNow })).toEqual([
      { reason: 'COOLDOWN', until: new Date(justNow.getTime() + 3_600_000) },
    ]);
    const anHourAgo = new Date(now.getTime() - 60 * 60_000);
    expect(ask('100', { lastRequestedAt: anHourAgo })).toEqual([]);
  });

  it('never compares as a float', () => {
    // 0.1 + 0.2 territory: three requests of 0.10 against a cap of 0.30.
    expect(
      ask('0.10', {
        policy: { minimum: '0.01', dailyLimit: '0.30' },
        requestedToday: '0.20',
      }),
    ).toEqual([]);
  });
});

describe('whether a person must say yes', () => {
  it('always, when no threshold is set', () => {
    expect(needsHumanApproval('1', 'USD', null)).toBe(true);
  });

  it('below the threshold no; at it and above, yes', () => {
    expect(needsHumanApproval('99.99', 'USD', '100')).toBe(false);
    expect(needsHumanApproval('100', 'USD', '100')).toBe(true);
    expect(needsHumanApproval('100.01', 'USD', '100')).toBe(true);
  });
});
