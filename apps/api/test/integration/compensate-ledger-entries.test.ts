import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { withTenant } from '@tp/tenancy';
import { LedgerService } from '../../src/accounts/ledger.service';
import {
  CompensationRefused,
  apply,
  parseArgs,
  plan,
} from '../../src/cli/compensate-ledger-entries';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  TEST_DATABASE_URL,
  assertDisposable,
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Reversing entries from the host: the same compensating entry the panel
 * posts, with the plain owner client the host has, and every refusal the
 * header lists. The case it was written for is production's TP-100001, where
 * a bug fixed on 1 September had posted seventeen swap rows twice.
 */
suite('compensating ledger entries from the host', () => {
  let scoped: PrismaClient;
  let plain: PrismaClient;
  const ledger = new LedgerService();
  const ORIGIN = { host: 'test-host', user: 'operator' };
  const tenant = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

  beforeAll(() => {
    scoped = createTestClient();
    plain = new PrismaClient({
      datasources: { db: { url: assertDisposable(TEST_DATABASE_URL as string) } },
    });
  });
  afterAll(async () => {
    await scoped.$disconnect();
    await plain.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(scoped);
  });

  /** An account with a deposit and two swap rows, one of them the duplicate. */
  async function funded(): Promise<{ accountId: string; deposit: string; swaps: string[] }> {
    const { accountId } = await createAccount(scoped, { balance: '0' });
    const ids = await withTenant(tenant, () =>
      scoped.$transaction(async (tx) => {
        await ledger.lockAccount(tx, accountId);
        const deposit = await ledger.post(tx, {
          accountId,
          type: 'DEPOSIT',
          amount: Money.of('1000', 'USD'),
        });
        const first = await ledger.post(tx, {
          accountId,
          type: 'SWAP',
          amount: Money.of('4.75', 'USD'),
          description: 'Overnight financing, 1 night(s), 2026-09-01',
        });
        const duplicate = await ledger.post(tx, {
          accountId,
          type: 'SWAP',
          amount: Money.of('4.75', 'USD'),
          description: 'Swap released on closing XAUUSD',
        });
        // A loss, so that reversing the deposit would overdraw the account.
        await ledger.post(tx, { accountId, type: 'TRADE_LOSS', amount: Money.of('-20', 'USD') });
        return { deposit: deposit.entryId, swaps: [first.entryId, duplicate.entryId] };
      }),
    );
    return { accountId, ...ids };
  }

  it('plans without writing, showing each reversal and the net', async () => {
    const { accountId, swaps } = await funded();
    const planned = await plan(plain, [swaps[1]!]);
    expect(planned).toMatchObject({
      accountId,
      balance: '989.50',
      balanceAfter: '984.75',
      net: '-4.75',
    });
    expect(planned.entries[0]).toMatchObject({ amount: '4.75', reversal: '-4.75' });
    const before = await plain.balanceLedger.count({ where: { accountId } });
    await plan(plain, [swaps[1]!]);
    expect(await plain.balanceLedger.count({ where: { accountId } })).toBe(before);
  });

  it('posts the compensating entries, moves the balance, and writes the audit row', async () => {
    const { accountId, swaps } = await funded();
    const planned = await plan(plain, [swaps[1]!]);
    const result = await apply(plain, planned, {
      reason: 'duplicate swap from the 1 Sept bug',
      origin: ORIGIN,
    });
    expect(result).toEqual({ posted: 1, balanceAfter: '984.75' });

    const account = await plain.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('984.75');
    const reversal = await plain.balanceLedger.findFirstOrThrow({
      where: { compensatesId: swaps[1]! },
    });
    expect(reversal).toMatchObject({
      type: 'ADJUSTMENT',
      description: 'duplicate swap from the 1 Sept bug',
    });
    expect(Money.of(reversal.amount.toString(), 'USD').toString()).toBe('-4.75');
    // The original is untouched: the table refuses updates, and nothing tried.
    const original = await plain.balanceLedger.findUniqueOrThrow({ where: { id: swaps[1]! } });
    expect(Money.of(original.amount.toString(), 'USD').toString()).toBe('4.75');

    const audit = await plain.auditLog.findFirstOrThrow({
      where: { resourceId: accountId, action: 'account.balance_adjusted' },
    });
    expect(audit.actorType).toBe('SYSTEM');
    expect(audit.after).toMatchObject({
      postedFrom: 'host',
      host: 'test-host',
      net: '-4.75',
      compensated: [{ id: swaps[1], reversal: '-4.75' }],
    });
  });

  it('leaves the ledger and the cached balance agreeing', async () => {
    const { accountId, swaps } = await funded();
    await apply(plain, await plan(plain, swaps), {
      reason: 'both swap rows, for the test',
      origin: ORIGIN,
    });
    const replay = await withTenant(tenant, () =>
      scoped.$transaction((tx) => ledger.replayBalance(tx, accountId)),
    );
    expect(replay.matches).toBe(true);
    expect(replay.replayed.toString()).toBe('980.00');
  });

  it('refuses to reverse an entry twice', async () => {
    const { swaps } = await funded();
    await apply(plain, await plan(plain, [swaps[1]!]), {
      reason: 'the first time, on purpose',
      origin: ORIGIN,
    });
    await expect(plan(plain, [swaps[1]!])).rejects.toBeInstanceOf(CompensationRefused);
    await expect(plan(plain, [swaps[1]!, swaps[1]!])).rejects.toThrow(/more than once/);
  });

  it('refuses entries on two accounts in one run', async () => {
    const a = await funded();
    const b = await funded();
    await expect(plan(plain, [a.swaps[1]!, b.swaps[1]!])).rejects.toThrow(/2 accounts/);
  });

  it('refuses a reversal that would take the account below zero', async () => {
    const { deposit } = await funded();
    await expect(plan(plain, [deposit])).rejects.toThrow(/below zero/);
  });

  it('refuses an id that is not an entry, and a reason too short to read back', async () => {
    const { swaps } = await funded();
    await expect(plan(plain, ['00000000-0000-0000-0000-000000000000'])).rejects.toThrow(
      /No ledger entry/,
    );
    await expect(
      apply(plain, await plan(plain, [swaps[1]!]), { reason: 'dup', origin: ORIGIN }),
    ).rejects.toThrow(/reason/);
  });

  it('reads its arguments, and posts nothing without --apply', () => {
    expect(parseArgs(['--entry', 'a', '--entry', 'b', '--reason', 'why'])).toEqual({
      entries: ['a', 'b'],
      reason: 'why',
      applyNow: false,
    });
    expect(parseArgs(['--entry', 'a', '--reason', 'why', '--apply']).applyNow).toBe(true);
    expect(() => parseArgs(['--reason', 'why'])).toThrow(/--entry/);
    expect(() => parseArgs(['--entry', 'a'])).toThrow(/--reason/);
  });
});
