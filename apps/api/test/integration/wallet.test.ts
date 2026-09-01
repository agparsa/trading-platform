import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { toDecimal } from '@tp/financial-core';
import { WalletService } from '../../src/wallet/wallet.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Two ledgers, and the one thing that must never be true of them.
 *
 * The plan for this phase said it in a line: two ledgers that both believe they
 * are authoritative is the classic way to lose money in an accounting system.
 * These two are authoritative for different pots — what is inside a trading
 * account, and what is held for a person and in no account — and a transfer
 * moves money between them.
 *
 * So nearly every test here adds both pots up before and after. A transfer that
 * wrote one row and not the other would pass every assertion about balances and
 * fail exactly one: this one.
 */
suite('wallets', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let wallets: WalletService;
  let userId: string;
  let accountId: string;

  /** Every pot on the platform, added up. A transfer must not change this. */
  const totalMoney = async (): Promise<string> => {
    const accounts = await prisma.account.aggregate({ _sum: { balance: true } });
    const walletRows = await prisma.wallet.aggregate({ _sum: { balance: true } });
    return toDecimal(accounts._sum.balance?.toString() ?? '0')
      .plus(toDecimal(walletRows._sum.balance?.toString() ?? '0'))
      .toFixed(10);
  };

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    const created = await createAccount(prisma, { balance: '1000' });
    userId = created.userId;
    accountId = created.accountId;
    wallets = new WalletService(
      prisma as unknown as PrismaService,
      stack.ledger,
      stack.accountState,
      new AuditService(prisma as unknown as PrismaService),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const fund = async (amount: string, key = `seed-${Math.random()}`) => {
    const wallet = await wallets.ensure(userId, 'USD');
    return wallets.adjust({
      walletId: wallet.id,
      type: 'DEPOSIT',
      amount,
      reason: 'bank transfer seen on the statement',
      idempotencyKey: key,
      actorId: userId,
    });
  };

  describe('the wallet itself', () => {
    it('is created on demand, one per currency', async () => {
      const usd = await wallets.ensure(userId, 'USD');
      const eur = await wallets.ensure(userId, 'EUR');
      expect(usd.id).not.toBe(eur.id);
      expect(await wallets.ensure(userId, 'USD')).toMatchObject({ id: usd.id });
      expect((await wallets.list(userId)).map((w) => w.currency)).toEqual(['EUR', 'USD']);
    });

    it('starts empty rather than at some invented opening balance', async () => {
      expect((await wallets.ensure(userId, 'USD')).balance).toBe('0.00');
    });
  });

  describe('a transfer', () => {
    it('does not change how much money exists', async () => {
      await fund('500');
      const before = await totalMoney();

      await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '200',
        idempotencyKey: 'transfer-1',
        actorId: userId,
      });

      expect(await totalMoney()).toBe(before);
    });

    it('moves it in the direction asked, on both sides', async () => {
      await fund('500');
      const result = await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '200',
        idempotencyKey: 'transfer-2',
        actorId: userId,
      });

      expect(result.wallet.balance).toBe('300.00');
      expect(result.accountBalance).toBe('1200.00');

      const account = await prisma.account.findFirstOrThrow({ where: { id: accountId } });
      expect(account.balance.toString()).toBe('1200');
      const wallet = await prisma.wallet.findFirstOrThrow({ where: { userId, currency: 'USD' } });
      expect(wallet.balance.toString()).toBe('300');
    });

    it('comes back the other way', async () => {
      await fund('500');
      await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '200',
        idempotencyKey: 'out',
        actorId: userId,
      });
      const before = await totalMoney();

      const back = await wallets.transfer({
        userId,
        accountId,
        direction: 'to-wallet',
        amount: '150',
        idempotencyKey: 'in',
        actorId: userId,
      });

      expect(back.wallet.balance).toBe('450.00');
      expect(back.accountBalance).toBe('1050.00');
      expect(await totalMoney()).toBe(before);
    });

    /**
     * The two rows are the audit trail. A movement on one side with nothing
     * pointing at the other is the shape a lost transfer would have.
     */
    it('writes a row on each ledger, and each names the other', async () => {
      await fund('500');
      await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '200',
        idempotencyKey: 'linked',
        actorId: userId,
      });

      const movement = await prisma.walletTransaction.findFirstOrThrow({
        where: { type: 'TRANSFER_OUT' },
      });
      expect(movement.accountId).toBe(accountId);
      expect(movement.ledgerEntryId).not.toBeNull();

      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { id: movement.ledgerEntryId ?? '' },
      });
      expect(entry.referenceType).toBe('WalletTransfer');
      expect(entry.amount.toString()).toBe('200');
      expect(movement.amount.toString()).toBe('-200');
      // The whole invariant, on one pair of rows.
      expect(
        toDecimal(entry.amount.toString()).plus(toDecimal(movement.amount.toString())).isZero(),
      ).toBe(true);
    });

    it('is safe to retry', async () => {
      await fund('500');
      const first = await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '200',
        idempotencyKey: 'same-key',
        actorId: userId,
      });
      const total = await totalMoney();

      const second = await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '200',
        idempotencyKey: 'same-key',
        actorId: userId,
      });

      expect(second.wallet.balance).toBe(first.wallet.balance);
      expect(second.accountBalance).toBe(first.accountBalance);
      expect(await totalMoney()).toBe(total);
      expect(await prisma.walletTransaction.count({ where: { type: 'TRANSFER_OUT' } })).toBe(1);
    });

    it('refuses to move more than the wallet holds', async () => {
      await fund('100');
      await expect(
        wallets.transfer({
          userId,
          accountId,
          direction: 'to-account',
          amount: '250',
          idempotencyKey: 'too-much',
          actorId: userId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INSUFFICIENT_MARGIN });
      expect((await wallets.ensure(userId, 'USD')).balance).toBe('100.00');
    });

    it('refuses a negative or zero amount rather than treating it as the other direction', async () => {
      await fund('500');
      for (const amount of ['-50', '0']) {
        await expect(
          wallets.transfer({
            userId,
            accountId,
            direction: 'to-account',
            amount,
            idempotencyKey: `bad-${amount}`,
            actorId: userId,
          }),
        ).rejects.toBeInstanceOf(DomainError);
      }
    });

    it('refuses somebody else’s account, and says not-found rather than forbidden', async () => {
      await fund('500');
      const other = await createAccount(prisma, { balance: '0', email: 'other@test.local' });
      await expect(
        wallets.transfer({
          userId,
          accountId: other.accountId,
          direction: 'to-account',
          amount: '10',
          idempotencyKey: 'not-mine',
          actorId: userId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.RESOURCE_NOT_FOUND });
    });

    /**
     * A frozen account can still be emptied. Trapping somebody's money inside an
     * account they may not trade is a different punishment from stopping them
     * trading, and only one of them was decided.
     */
    it('lets money out of a suspended account but not in', async () => {
      await fund('500');
      await prisma.account.update({ where: { id: accountId }, data: { status: 'SUSPENDED' } });

      await expect(
        wallets.transfer({
          userId,
          accountId,
          direction: 'to-account',
          amount: '10',
          idempotencyKey: 'into-suspended',
          actorId: userId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.ACCOUNT_NOT_TRADEABLE });

      const out = await wallets.transfer({
        userId,
        accountId,
        direction: 'to-wallet',
        amount: '10',
        idempotencyKey: 'out-of-suspended',
        actorId: userId,
      });
      expect(out.wallet.balance).toBe('510.00');
    });

    it('records who moved what', async () => {
      await fund('500');
      await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '200',
        idempotencyKey: 'audited',
        actorId: userId,
      });
      const entry = await prisma.auditLog.findFirst({
        where: { action: 'wallet.transfer.out' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.actorId).toBe(userId);
      expect((entry?.after as { amount: string } | null)?.amount).toBe('200.00');
    });
  });

  /**
   * The rule that makes an outbound transfer different from reading a balance.
   *
   * A trading account's balance includes money that is currently margin for an
   * open position. Letting that leave would close somebody's position for them —
   * from the wallet screen, silently, at a price nobody chose. So the limit is
   * free margin, computed by the same service the terminal reads, which means
   * the number a trader is refused against is the number they were looking at.
   */
  describe('what limits an outbound transfer', () => {
    const openOneLot = async () => {
      await stack.publishQuote('XAUUSD', '4600.00', '4600.14');
      return stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '0.01',
      });
    };

    it('is free margin, not balance', async () => {
      await openOneLot();
      const { state } = await stack.accountState.valuate(accountId);
      expect(state.usedMargin.isPositive()).toBe(true);
      // The account still holds its whole balance; some of it is committed.
      expect(state.balance.gt(state.freeMargin)).toBe(true);

      await expect(
        wallets.transfer({
          userId,
          accountId,
          direction: 'to-wallet',
          amount: state.balance.toString(),
          idempotencyKey: 'take-the-margin',
          actorId: userId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INSUFFICIENT_MARGIN });
    });

    it('allows exactly what is free', async () => {
      await openOneLot();
      const { state } = await stack.accountState.valuate(accountId);
      const before = await totalMoney();

      const moved = await wallets.transfer({
        userId,
        accountId,
        direction: 'to-wallet',
        amount: state.freeMargin.toString(),
        idempotencyKey: 'exactly-free',
        actorId: userId,
      });

      expect(moved.wallet.balance).toBe(state.freeMargin.toString());
      expect(await totalMoney()).toBe(before);
      // And the position is untouched — which is the whole point of the rule.
      expect(await prisma.position.count({ where: { accountId, status: 'OPEN' } })).toBe(1);
    });

    it('says how much is free and why the rest is not', async () => {
      await openOneLot();
      const thrown = await wallets
        .transfer({
          userId,
          accountId,
          direction: 'to-wallet',
          amount: '1000',
          idempotencyKey: 'why',
          actorId: userId,
        })
        .then(
          () => undefined,
          (error: unknown) => error as DomainError,
        );
      expect(thrown?.message).toMatch(/free/i);
      expect(thrown?.details?.['usedMargin']).toBeDefined();
    });
  });

  describe('an adjustment', () => {
    it('credits a deposit and debits a withdrawal from the same positive amount', async () => {
      const after = await fund('500');
      expect(after.balance).toBe('500.00');

      const wallet = await wallets.ensure(userId, 'USD');
      const out = await wallets.adjust({
        walletId: wallet.id,
        type: 'WITHDRAWAL',
        amount: '200',
        reason: 'paid out by bank transfer',
        idempotencyKey: 'w-1',
        actorId: userId,
      });
      expect(out.balance).toBe('300.00');
    });

    it('refuses a negative amount where the type already says the direction', async () => {
      const wallet = await wallets.ensure(userId, 'USD');
      await expect(
        wallets.adjust({
          walletId: wallet.id,
          type: 'DEPOSIT',
          amount: '-100',
          reason: 'this would be a debit wearing a credit’s name',
          idempotencyKey: 'neg',
          actorId: userId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('refuses a reason nobody could read later', async () => {
      const wallet = await wallets.ensure(userId, 'USD');
      await expect(
        wallets.adjust({
          walletId: wallet.id,
          type: 'DEPOSIT',
          amount: '10',
          reason: ' ',
          idempotencyKey: 'no-reason',
          actorId: userId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });

    it('cannot take a wallet negative', async () => {
      await fund('100');
      const wallet = await wallets.ensure(userId, 'USD');
      await expect(
        wallets.adjust({
          walletId: wallet.id,
          type: 'WITHDRAWAL',
          amount: '250',
          reason: 'more than is there',
          idempotencyKey: 'overdraw',
          actorId: userId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INSUFFICIENT_MARGIN });
    });

    /**
     * The row is never edited. `wallet_transactions` carries the same
     * append-only trigger the balance ledger does, so a correction is a new row
     * that names the old one.
     */
    it('corrects by compensating rather than by editing', async () => {
      const wallet = await wallets.ensure(userId, 'USD');
      await fund('500', 'orig');
      const original = await prisma.walletTransaction.findFirstOrThrow({
        where: { type: 'DEPOSIT' },
      });

      await wallets.adjust({
        walletId: wallet.id,
        type: 'ADJUSTMENT',
        amount: '-500',
        reason: 'the deposit was recorded twice',
        compensatesId: original.id,
        idempotencyKey: 'fix',
        actorId: userId,
      });

      expect((await wallets.ensure(userId, 'USD')).balance).toBe('0.00');
      const correction = await prisma.walletTransaction.findFirstOrThrow({
        where: { type: 'ADJUSTMENT' },
      });
      expect(correction.compensatesId).toBe(original.id);
      // And the original is exactly as it was.
      const unchanged = await prisma.walletTransaction.findFirstOrThrow({
        where: { id: original.id },
      });
      expect(unchanged.amount.toString()).toBe(original.amount.toString());
    });

    it('refuses to let anything update a movement, at the database', async () => {
      await fund('100');
      const row = await prisma.walletTransaction.findFirstOrThrow({});
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE wallet_transactions SET amount = 999 WHERE id = $1::uuid`,
          row.id,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('freezing', () => {
    it('stops money moving in either direction, and says so', async () => {
      await fund('500');
      const wallet = await wallets.ensure(userId, 'USD');
      await wallets.setStatus({
        walletId: wallet.id,
        status: 'FROZEN',
        reason: 'under review',
        actorId: userId,
      });

      await expect(
        wallets.transfer({
          userId,
          accountId,
          direction: 'to-account',
          amount: '10',
          idempotencyKey: 'frozen-out',
          actorId: userId,
        }),
      ).rejects.toThrow(/frozen/i);

      // Released, it moves again — the money was held, not taken.
      await wallets.setStatus({
        walletId: wallet.id,
        status: 'ACTIVE',
        reason: 'review closed',
        actorId: userId,
      });
      const done = await wallets.transfer({
        userId,
        accountId,
        direction: 'to-account',
        amount: '10',
        idempotencyKey: 'thawed',
        actorId: userId,
      });
      expect(done.wallet.balance).toBe('490.00');
    });

    it('records both the freeze and the release', async () => {
      const wallet = await wallets.ensure(userId, 'USD');
      await wallets.setStatus({
        walletId: wallet.id,
        status: 'FROZEN',
        reason: 'under review',
        actorId: userId,
      });
      await wallets.setStatus({
        walletId: wallet.id,
        status: 'ACTIVE',
        reason: 'review closed',
        actorId: userId,
      });
      const actions = (
        await prisma.auditLog.findMany({
          where: { resourceType: 'Wallet' },
          orderBy: { createdAt: 'asc' },
        })
      ).map((entry) => entry.action);
      expect(actions).toContain('wallet.frozen');
      expect(actions).toContain('wallet.released');
    });
  });
});
