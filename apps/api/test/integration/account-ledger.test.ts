import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { Money } from '@tp/financial-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { AccountAccessService } from '../../src/accounts/account-access.service';
import { AccountsController } from '../../src/accounts/accounts.controller';
import { AccountsService } from '../../src/accounts/accounts.service';
import { LedgerService } from '../../src/accounts/ledger.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createAccount, createTestClient, hasTestDatabase, resetDatabase } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * `GET /accounts/:id/ledger` — the balance history a trader reads.
 *
 * Driven through the controller, so the route's own parameters (the caller,
 * the account, the page size, the cursor) are what is tested, not a service
 * call a route might have forgotten to make.
 */
suite('The account ledger, read by its owner (integration)', () => {
  let prisma: PrismaClient;
  let controller: AccountsController;
  const ledger = new LedgerService();

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    const service = prisma as unknown as PrismaService;
    controller = new AccountsController(
      new AccountsService(
        service,
        new AccountAccessService(service),
        ledger,
        new ConfigService({}) as never,
      ),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const asUser = (id: string) => ({ id }) as never;

  /** Every entry, read a page at a time the way the screen reads it. */
  async function readAll(userId: string, accountId: string, limit: number) {
    const seen: Array<{ id: string; amount: string; createdAt: string }> = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await controller.ledger(asUser(userId), accountId, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      } as never);
      seen.push(...page.entries);
      if (page.nextCursor === undefined) return seen;
      cursor = page.nextCursor;
    }
    throw new Error('the ledger never ran out of pages');
  }

  /**
   * Several entries can share one instant: Prisma stamps `created_at` to the
   * millisecond, and a close posts its profit, its commission and its swap
   * in one transaction. Written here with one explicit instant, so the tie is
   * certain. Read one, two and four to a page, a boundary falls inside the
   * group each time, and every entry must still appear exactly once.
   *
   * This passed before the `id` tiebreak too — Prisma then read every row up
   * to the cursor and cut the page in memory, correct but unbounded.
   * `scripts/cursor-order.test.ts` is what fails without the tiebreak; this
   * one keeps the bounded query honest.
   */
  it('pages through entries that share one instant without repeating or skipping one', async () => {
    const { userId, accountId } = await createAccount(prisma);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    const instant = new Date('2026-10-17T08:00:00.000Z');
    const amounts = ['100000', '-118.00', '136.94', '-7.00', '-2.50', '41.10'];
    let balance = Money.of('0', 'USD');
    for (const amount of amounts) {
      balance = balance.plus(Money.of(amount, 'USD'));
      await prisma.balanceLedger.create({
        data: {
          tenantId: account.tenantId,
          accountId,
          type: amount.startsWith('-') ? 'TRADE_LOSS' : 'DEPOSIT',
          amount,
          balanceAfter: balance.toString(),
          currency: 'USD',
          createdAt: instant,
        },
      });
    }

    for (const limit of [1, 2, 4]) {
      const seen = await readAll(userId, accountId, limit);
      expect(seen.map((entry) => entry.createdAt)).toEqual(
        amounts.map(() => instant.toISOString()),
      );
      expect(new Set(seen.map((entry) => entry.id)).size, `${limit} to a page`).toBe(
        amounts.length,
      );
      expect(seen.map((entry) => entry.amount).sort()).toEqual(
        amounts.map((amount) => Money.of(amount, 'USD').toString()).sort(),
      );
    }
  });

  it('reads newest first, with the balance each entry left', async () => {
    const { userId, accountId } = await createAccount(prisma);
    for (const [amount, type] of [
      ['5000', 'DEPOSIT'],
      ['-12.50', 'COMMISSION'],
    ] as const) {
      await prisma.$transaction((tx) =>
        ledger.post(tx, { accountId, type, amount: Money.of(amount, 'USD') }),
      );
    }
    const page = await controller.ledger(asUser(userId), accountId, { limit: 50 } as never);
    expect(page.entries.map((entry) => [entry.type, entry.amount, entry.balanceAfter])).toEqual([
      ['COMMISSION', '-12.50', '4987.50'],
      ['DEPOSIT', '5000.00', '5000.00'],
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("refuses another trader's ledger exactly as it refuses one that does not exist", async () => {
    const alice = await createAccount(prisma);
    const mallory = await createAccount(prisma);
    await prisma.$transaction((tx) =>
      ledger.post(tx, {
        accountId: alice.accountId,
        type: 'DEPOSIT',
        amount: Money.of('100', 'USD'),
      }),
    );
    const codeOf = async (accountId: string) => {
      try {
        await controller.ledger(asUser(mallory.userId), accountId, { limit: 50 } as never);
      } catch (error) {
        return error instanceof DomainError ? error.code : String(error);
      }
      return 'served';
    };
    expect(await codeOf(alice.accountId)).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
    expect(await codeOf('00000000-0000-4000-8000-000000000000')).toBe(
      TradingErrorCode.RESOURCE_NOT_FOUND,
    );
  });
});
