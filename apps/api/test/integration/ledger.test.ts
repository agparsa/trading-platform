import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { LedgerService } from '../../src/accounts/ledger.service';
import { createAccount, createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

suite('LedgerService (integration)', () => {
  let prisma: PrismaClient;
  const ledger = new LedgerService();

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('records a deposit and updates the cached balance in the same transaction', async () => {
    const { accountId } = await createAccount(prisma);

    const result = await prisma.$transaction((tx) =>
      ledger.post(tx, {
        accountId,
        type: 'DEPOSIT',
        amount: Money.of('100000', 'USD'),
        description: 'opening',
      }),
    );

    expect(result.balanceAfter.toString()).toBe('100000.00');
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('100000.00');
  });

  it('carries balanceAfter forward across a sequence of entries', async () => {
    const { accountId } = await createAccount(prisma);
    const postings: Array<[string, 'DEPOSIT' | 'TRADE_PROFIT' | 'TRADE_LOSS' | 'COMMISSION']> = [
      ['100000', 'DEPOSIT'],
      ['-118.00', 'TRADE_LOSS'],
      ['136.94', 'TRADE_PROFIT'],
      ['-7.00', 'COMMISSION'],
    ];

    for (const [amount, type] of postings) {
      await prisma.$transaction((tx) =>
        ledger.post(tx, { accountId, type, amount: Money.of(amount, 'USD') }),
      );
    }

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('100011.94');

    const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
    expect(replay.matches).toBe(true);
    expect(replay.replayed.toString()).toBe('100011.94');
  });

  /**
   * The lost-update test. Without `SELECT ... FOR UPDATE` in `post`, both
   * transactions read the same starting balance and the second overwrites the
   * first — the account ends up 100 richer than the ledger says.
   */
  /**
   * The invariant the whole ledger exists to provide: the balance is the sum of
   * the entries. Not approximately, not after a correction — exactly, on every
   * account, for ever.
   *
   * It was broken. `post()` rounded the amount it stored and, separately,
   * rounded `before + amount` to get the new balance. Given a sub-cent posting
   * — a commission of 0.175, which is what 0.05 lots of a major pair actually
   * costs — those two roundings disagreed: the row said 0.18 and the balance
   * moved 0.17. Every account that had ever paid a fractional commission drifted
   * by a cent per trade, silently, and the only thing that would ever have
   * noticed is the reconciliation job flagging drift with no cause to point at.
   */
  it('keeps the balance exactly equal to the sum of the entries, at sub-cent precision', async () => {
    const { accountId, currency } = await createAccount(prisma);

    await prisma.$transaction(async (tx) => {
      await ledger.lockAccount(tx, accountId);
      await ledger.post(tx, {
        accountId,
        type: 'DEPOSIT',
        amount: Money.of('100000', currency),
      });
      // Three of them: one cent of drift per entry is easy to miss, three is not.
      for (let i = 0; i < 3; i += 1) {
        await ledger.post(tx, {
          accountId,
          type: 'COMMISSION',
          amount: Money.of('-0.175', currency),
          description: 'a commission that does not land on a cent',
        });
      }
    });

    const entries = await prisma.balanceLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

    const summed = entries.reduce((total, entry) => total + Number(entry.amount), 0);
    expect(Number(account.balance)).toBeCloseTo(summed, 10);

    // And each row's own running total agrees with the amounts above it, so a
    // human reading the ledger down the page arrives at the stored balance.
    let running = 0;
    for (const entry of entries) {
      running += Number(entry.amount);
      expect(Number(entry.balanceAfter)).toBeCloseTo(running, 10);
    }
    expect(Number(entries.at(-1)?.balanceAfter)).toBeCloseTo(Number(account.balance), 10);
  });

  it('serialises concurrent postings instead of losing one', async () => {
    const { accountId } = await createAccount(prisma, { balance: '1000' });

    const concurrent = 10;
    await Promise.all(
      Array.from({ length: concurrent }, () =>
        prisma.$transaction((tx) =>
          ledger.post(tx, { accountId, type: 'DEPOSIT', amount: Money.of('100', 'USD') }),
        ),
      ),
    );

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('2000.00');

    const entries = await prisma.balanceLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries).toHaveLength(concurrent + 1);

    const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
    expect(replay.matches).toBe(true);
  });

  it('never applies the same idempotency key twice', async () => {
    const { accountId } = await createAccount(prisma);
    const posting = {
      accountId,
      type: 'DEPOSIT' as const,
      amount: Money.of('500', 'USD'),
      idempotencyKey: `deposit:${accountId}:1`,
    };

    const first = await prisma.$transaction((tx) => ledger.post(tx, posting));
    const second = await prisma.$transaction((tx) => ledger.post(tx, posting));

    expect(second.entryId).toBe(first.entryId);
    expect(second.balanceAfter.toString()).toBe('500.00');
    expect(await prisma.balanceLedger.count({ where: { accountId } })).toBe(1);
  });

  it('refuses an entry in the wrong currency rather than converting silently', async () => {
    const { accountId } = await createAccount(prisma, { currency: 'USD' });
    await expect(
      prisma.$transaction((tx) =>
        ledger.post(tx, { accountId, type: 'DEPOSIT', amount: Money.of('100', 'EUR') }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('reverses an entry with a compensating one and leaves the original intact', async () => {
    const { accountId } = await createAccount(prisma);
    const original = await prisma.$transaction((tx) =>
      ledger.post(tx, { accountId, type: 'DEPOSIT', amount: Money.of('250', 'USD') }),
    );

    const reversal = await prisma.$transaction((tx) =>
      ledger.compensate(tx, original.entryId, 'duplicate deposit'),
    );

    expect(reversal.balanceAfter.toString()).toBe('0.00');
    const rows = await prisma.balanceLedger.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.amount.toString()).toBe('250');
    expect(rows[1]?.type).toBe('ADJUSTMENT');
    expect(rows[1]?.compensatesId).toBe(original.entryId);
  });

  it('rolls the ledger entry back when the surrounding transaction fails', async () => {
    const { accountId } = await createAccount(prisma);

    await expect(
      prisma.$transaction(async (tx) => {
        await ledger.post(tx, { accountId, type: 'DEPOSIT', amount: Money.of('999', 'USD') });
        throw new Error('the operation this posting belonged to failed');
      }),
    ).rejects.toThrow('the operation this posting belonged to failed');

    expect(await prisma.balanceLedger.count({ where: { accountId } })).toBe(0);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('0.00');
  });

  it('reports a mismatch when the cached balance is tampered with', async () => {
    const { accountId } = await createAccount(prisma);
    await prisma.$transaction((tx) =>
      ledger.post(tx, { accountId, type: 'DEPOSIT', amount: Money.of('100', 'USD') }),
    );
    // Simulates the drift the reconciliation job exists to catch.
    await prisma.account.update({ where: { id: accountId }, data: { balance: '999' } });

    const replay = await prisma.$transaction((tx) => ledger.replayBalance(tx, accountId));
    expect(replay.matches).toBe(false);
    expect(replay.replayed.toString()).toBe('100.00');
    expect(replay.stored.toString()).toBe('999.00');
  });

  it('rejects a posting to an account that does not exist', async () => {
    await expect(
      prisma.$transaction((tx) =>
        ledger.post(tx, {
          accountId: '00000000-0000-4000-8000-000000000000',
          type: 'DEPOSIT',
          amount: Money.of('1', 'USD'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
