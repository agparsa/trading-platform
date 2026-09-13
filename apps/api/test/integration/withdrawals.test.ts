import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { toDecimal } from '@tp/financial-core';
import { WithdrawalStatus } from '@tp/withdrawals-core';
import { KycDocumentKind } from '@tp/kyc-core';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import {
  WithdrawalsService,
  destinationSealContext,
} from '../../src/withdrawals/withdrawals.service';
import { AdminWithdrawalsService } from '../../src/withdrawals/admin-withdrawals.service';
import { WalletService } from '../../src/wallet/wallet.service';
import { KycService } from '../../src/kyc/kyc.service';
import { AdminKycService } from '../../src/kyc/admin-kyc.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { SecretBoxService } from '../../src/common/crypto/crypto.module';
import type { NotificationsService } from '../../src/notifications/notifications.service';
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
 * Money leaving the platform, and the one sum that must never change.
 *
 * A withdrawal debits the wallet when it is asked for. From that moment until
 * it is paid, the money is on the platform and in nobody's balance — it is an
 * open hold. So the quantity that stays constant across the whole lifecycle
 * is *every wallet plus every open hold*: a request moves money from the first
 * pot to the second, a rejection moves it back, and a payment removes it from
 * both. Nearly every test here adds the two up before and after, because a
 * service that debited without recording the hold, or released twice, would
 * satisfy every assertion about status and fail exactly that one.
 */
suite('withdrawals', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let wallets: WalletService;
  let kyc: KycService;
  let adminKyc: AdminKycService;
  let withdrawals: WithdrawalsService;
  let admin: AdminWithdrawalsService;
  let secrets: SecretBox;
  let userId: string;
  let walletId: string;
  let financeId: string;
  let raised: Array<{ userId: string; kind: string }>;

  const KEY = generateEncryptionKey('test');

  const configure = (over: Record<string, unknown> = {}) =>
    new ConfigService<Record<string, unknown>, true>({
      SECRET_ENCRYPTION_KEYS: KEY,
      WITHDRAWAL_MIN_AMOUNT: '10',
      WITHDRAWAL_MAX_AMOUNT: '5000',
      WITHDRAWAL_DAILY_LIMIT: '8000',
      WITHDRAWAL_COOLDOWN_HOURS: 0,
      WITHDRAWAL_REQUIRE_KYC: true,
      ...over,
    } as never) as unknown as ConfigService<never, true>;

  const build = (over: Record<string, unknown> = {}) => {
    const prismaService = prisma as unknown as PrismaService;
    const audit = new AuditService(prismaService);
    const notifications = {
      raise: (job: { userId: string; kind: string }) => {
        raised.push(job);
        return Promise.resolve();
      },
    } as unknown as NotificationsService;
    const kycService = new KycService(
      prismaService,
      audit,
      secrets as SecretBoxService,
      configure(over),
    );
    const service = new WithdrawalsService(
      prismaService,
      wallets,
      kycService,
      audit,
      secrets as SecretBoxService,
      configure(over),
    );
    const adminService = new AdminWithdrawalsService(
      prismaService,
      service,
      kycService,
      audit,
      secrets as SecretBoxService,
      notifications,
    );
    return { service, adminService, kycService };
  };

  /** Every wallet, plus every hold that has not been released or paid. */
  const walletsPlusHolds = async (): Promise<string> => {
    const walletRows = await prisma.wallet.aggregate({ _sum: { balance: true } });
    const holds = await prisma.withdrawalRequest.findMany({
      where: {
        status: {
          in: [
            WithdrawalStatus.REQUESTED,
            WithdrawalStatus.UNDER_REVIEW,
            WithdrawalStatus.APPROVED,
            WithdrawalStatus.PROCESSING,
          ],
        },
      },
      select: { amount: true },
    });
    let total = toDecimal(walletRows._sum.balance?.toString() ?? '0');
    for (const hold of holds) total = total.plus(toDecimal(hold.amount.toString()));
    return total.toFixed(2);
  };

  const balance = async (): Promise<string> => {
    const wallet = await prisma.wallet.findFirstOrThrow({ where: { id: walletId } });
    return toDecimal(wallet.balance.toString()).toFixed(2);
  };

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    secrets = new SecretBox(parseEncryptionKeys(KEY));
    raised = [];

    const person = await createAccount(prisma, { balance: '0' });
    userId = person.userId;
    const finance = await createAccount(prisma, { balance: '0' });
    financeId = finance.userId;

    const prismaService = prisma as unknown as PrismaService;
    const audit = new AuditService(prismaService);
    wallets = new WalletService(prismaService, stack.ledger, stack.accountState, audit);
    const wallet = await wallets.ensure(userId, 'USD');
    walletId = wallet.id;
    await wallets.adjust({
      walletId,
      type: 'DEPOSIT',
      amount: '1000',
      reason: 'test funding',
      idempotencyKey: `fund-${Math.random()}`,
      actorId: financeId,
    });

    ({ service: withdrawals, adminService: admin, kycService: kyc } = build());
    adminKyc = new AdminKycService(
      prismaService,
      audit,
      secrets as SecretBoxService,
      { raise: () => Promise.resolve() } as unknown as NotificationsService,
      configure(),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const verify = async () => {
    const jpeg = Buffer.alloc(2048, 0x11);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    const png = Buffer.alloc(2048, 0x22);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await kyc.upload({ userId, kind: KycDocumentKind.PASSPORT, filename: 'p.jpg', bytes: jpeg });
    await kyc.upload({ userId, kind: KycDocumentKind.SELFIE, filename: 's.png', bytes: png });
    await kyc.submit(userId);
    const record = await prisma.kycRecord.findFirstOrThrow({ where: { userId } });
    await adminKyc.decide({
      recordId: record.id,
      outcome: 'VERIFIED',
      reason: 'Checked and consistent.',
      actorId: financeId,
    });
  };

  const request = (amount = '250', destination = 'GB29 NWBK 6016 1331 9268 19 — J Smith') =>
    withdrawals.request({
      userId,
      walletId,
      amount,
      destination,
      idempotencyKey: `req-${Math.random()}`,
    });

  describe('the gate', () => {
    it('refuses an unverified person, and says only that', async () => {
      const before = await walletsPlusHolds();
      await expect(request()).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
        message: expect.stringMatching(/identity has to be verified/),
      });
      expect(await walletsPlusHolds()).toBe(before);
      expect(await prisma.withdrawalRequest.count()).toBe(0);
    });

    it('lets a verified person through', async () => {
      await verify();
      const view = await request();
      expect(view.status).toBe(WithdrawalStatus.REQUESTED);
    });

    it('does not ask when the deployment does not', async () => {
      const lax = build({ WITHDRAWAL_REQUIRE_KYC: false });
      const view = await lax.service.request({
        userId,
        walletId,
        amount: '250',
        destination: 'GB29 NWBK 6016 1331 9268 19',
        idempotencyKey: 'lax',
      });
      expect(view.status).toBe(WithdrawalStatus.REQUESTED);
    });

    it('re-checks at approval, so a revocation in between is not approved through', async () => {
      await verify();
      const view = await request();
      const record = await prisma.kycRecord.findFirstOrThrow({ where: { userId } });
      await adminKyc.revoke({
        recordId: record.id,
        reason: 'Document reported stolen.',
        actorId: financeId,
      });

      await expect(
        admin.decide({
          id: view.id,
          outcome: 'APPROVED',
          reason: 'Looks fine.',
          actorId: financeId,
        }),
      ).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
        message: expect.stringMatching(/not currently verified/),
      });
      const after = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: view.id } });
      expect(after.status).toBe(WithdrawalStatus.REQUESTED);
    });
  });

  describe('the hold', () => {
    beforeEach(verify);

    it('debits the wallet at the request, and the sum of wallets and holds does not move', async () => {
      const before = await walletsPlusHolds();
      expect(await balance()).toBe('1000.00');

      const view = await request('250');

      expect(await balance()).toBe('750.00');
      expect(await walletsPlusHolds()).toBe(before);
      const row = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: view.id } });
      const hold = await prisma.walletTransaction.findFirstOrThrow({
        where: { id: row.holdTransactionId },
      });
      expect(hold.type).toBe('WITHDRAWAL');
      expect(toDecimal(hold.amount.toString()).toFixed(2)).toBe('-250.00');
      expect(hold.referenceId).toBe(view.id);
    });

    it('will not hold what the wallet does not have, even when two requests race for it', async () => {
      const before = await walletsPlusHolds();
      const results = await Promise.allSettled([request('600'), request('600')]);
      const fulfilled = results.filter((one) => one.status === 'fulfilled');
      // One of the two may go through; both cannot, whatever each read first.
      expect(fulfilled.length).toBeLessThanOrEqual(1);
      const after = toDecimal(await balance());
      expect(after.gte(0)).toBe(true);
      expect(await walletsPlusHolds()).toBe(before);
    });

    it('gives the money back on cancellation, once, with a movement that names the hold', async () => {
      const before = await walletsPlusHolds();
      const view = await request('250');
      expect(await balance()).toBe('750.00');

      const cancelled = await withdrawals.cancel({ userId, id: view.id, idempotencyKey: 'c1' });
      expect(cancelled.status).toBe(WithdrawalStatus.CANCELLED);
      expect(await balance()).toBe('1000.00');
      expect(await walletsPlusHolds()).toBe(before);

      const row = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: view.id } });
      const release = await prisma.walletTransaction.findFirstOrThrow({
        where: { id: row.releaseTransactionId ?? '' },
      });
      expect(release.compensatesId).toBe(row.holdTransactionId);
      expect(toDecimal(release.amount.toString()).toFixed(2)).toBe('250.00');

      // A second cancellation is refused and credits nothing.
      await expect(
        withdrawals.cancel({ userId, id: view.id, idempotencyKey: 'c2' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_STATE_TRANSITION });
      expect(await balance()).toBe('1000.00');
    });

    it('gives the money back on rejection, and tells the person', async () => {
      const before = await walletsPlusHolds();
      const view = await request('250');
      const rejected = await admin.decide({
        id: view.id,
        outcome: 'REJECTED',
        reason: 'The destination account name does not match the account holder.',
        actorId: financeId,
      });
      expect(rejected.status).toBe(WithdrawalStatus.REJECTED);
      expect(await balance()).toBe('1000.00');
      expect(await walletsPlusHolds()).toBe(before);
      expect(raised.map((one) => one.kind)).toEqual(['withdrawal.rejected']);
    });

    it('gives the money back when a payout fails after it was started', async () => {
      const before = await walletsPlusHolds();
      const view = await request('250');
      await admin.decide({
        id: view.id,
        outcome: 'APPROVED',
        reason: 'Checked.',
        actorId: financeId,
      });
      await admin.startPayout({ id: view.id, providerReference: 'TRF-1', actorId: financeId });
      expect(await balance()).toBe('750.00');

      const failed = await admin.settle({
        id: view.id,
        outcome: 'FAILED',
        reason: 'The bank returned the transfer: account closed.',
        actorId: financeId,
      });
      expect(failed.status).toBe(WithdrawalStatus.FAILED);
      expect(await balance()).toBe('1000.00');
      expect(await walletsPlusHolds()).toBe(before);
    });

    it('removes the money from both pots when paid, and never gives it back', async () => {
      const before = await walletsPlusHolds();
      const view = await request('250');
      await admin.decide({
        id: view.id,
        outcome: 'APPROVED',
        reason: 'Checked.',
        actorId: financeId,
      });
      await admin.startPayout({ id: view.id, providerReference: 'TRF-1', actorId: financeId });
      const paid = await admin.settle({
        id: view.id,
        outcome: 'PAID',
        reason: 'Sent from the operating account.',
        actorId: financeId,
      });
      expect(paid.status).toBe(WithdrawalStatus.PAID);
      expect(await balance()).toBe('750.00');
      // Paid money has left: wallets + holds is lower by exactly the amount.
      expect(
        toDecimal(before)
          .minus(toDecimal(await walletsPlusHolds()))
          .toFixed(2),
      ).toBe('250.00');

      // Nothing after PAID.
      await expect(
        admin.settle({ id: view.id, outcome: 'FAILED', reason: 'Oops.', actorId: financeId }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_STATE_TRANSITION });
      await expect(
        withdrawals.cancel({ userId, id: view.id, idempotencyKey: 'late' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_STATE_TRANSITION });
      expect(await balance()).toBe('750.00');
      expect(raised.map((one) => one.kind)).toEqual(['withdrawal.paid']);
    });

    it('keeps the wallet balance honest for a transfer into a trading account', async () => {
      /**
       * The reason the hold exists. Money asked for is not money that can be
       * moved into an account and traded while the transfer is in flight.
       */
      await request('900');
      expect(await balance()).toBe('100.00');
      const account = await prisma.account.findFirstOrThrow({ where: { userId } });
      await expect(
        wallets.transfer({
          userId,
          accountId: account.id,
          direction: 'to-account',
          amount: '500',
          idempotencyKey: 'xfer',
          actorId: userId,
        }),
      ).rejects.toBeInstanceOf(DomainError);
    });
  });

  describe('the limits', () => {
    beforeEach(verify);

    it('names every limit crossed at once', async () => {
      await expect(request('9000')).rejects.toMatchObject({
        message: expect.stringMatching(/largest single withdrawal.*wallet holds.*daily limit/s),
      });
    });

    it('counts what was already asked for today, and not what was cancelled', async () => {
      await wallets.adjust({
        walletId,
        type: 'DEPOSIT',
        amount: '9000',
        reason: 'test funding',
        idempotencyKey: 'more',
        actorId: financeId,
      });
      const first = await request('4000');
      await request('3000');
      await expect(request('1500')).rejects.toMatchObject({
        message: expect.stringMatching(/1000\.00 USD of the 8000\.00 USD daily limit remains/),
      });
      await withdrawals.cancel({ userId, id: first.id, idempotencyKey: 'c' });
      // 4000 came back to the wallet and stopped counting.
      const view = await request('1500');
      expect(view.status).toBe(WithdrawalStatus.REQUESTED);
    });

    it('holds the cooldown between requests', async () => {
      const strict = build({ WITHDRAWAL_COOLDOWN_HOURS: 24 });
      await strict.service.request({
        userId,
        walletId,
        amount: '100',
        destination: 'GB29 NWBK 6016 1331 9268 19',
        idempotencyKey: 'a',
      });
      await expect(
        strict.service.request({
          userId,
          walletId,
          amount: '100',
          destination: 'GB29 NWBK 6016 1331 9268 19',
          idempotencyKey: 'b',
        }),
      ).rejects.toMatchObject({ message: expect.stringMatching(/next request can be made at/) });
    });

    it('states the terms before a request is made', async () => {
      await request('1000');
      const terms = await withdrawals.terms(userId, 'USD');
      expect(terms).toMatchObject({
        minimum: '10.00',
        maximum: '5000.00',
        dailyLimit: '8000.00',
        remainingToday: '7000.00',
        identityRequired: true,
        identityVerified: true,
        nextAllowedAt: null,
      });
    });

    it('refuses a frozen wallet', async () => {
      await wallets.setStatus({
        walletId,
        status: 'FROZEN',
        reason: 'Under review',
        actorId: financeId,
      });
      await expect(request('100')).rejects.toMatchObject({
        message: expect.stringMatching(/frozen/),
      });
    });
  });

  describe('the destination', () => {
    beforeEach(verify);

    it('is sealed in the row, bound to the request, and opened only with an audit row', async () => {
      const view = await request('250', 'GB29 NWBK 6016 1331 9268 19 — J Smith');
      const row = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: view.id } });
      expect(row.destination).not.toContain('NWBK');
      expect(row.destination).not.toContain('Smith');
      expect(row.destinationHint).toBe('mith');
      expect(secrets.open(row.destination, destinationSealContext(row.id))).toContain('J Smith');

      const opened = await admin.openDestination({ id: view.id, actorId: financeId });
      expect(opened.destination).toContain('J Smith');
      const trail = await prisma.auditLog.findMany({
        where: { action: 'withdrawal.destination.viewed', resourceId: view.id },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]?.actorId).toBe(financeId);
      // Neither the audit rows nor the person's own view carry the whole thing.
      const everything = JSON.stringify(await prisma.auditLog.findMany());
      expect(everything).not.toContain('NWBK');
      expect(JSON.stringify(await withdrawals.list(userId))).not.toContain('NWBK');
    });
  });

  describe('the desk', () => {
    beforeEach(verify);

    it('shows the queue oldest first with the person’s verification beside it', async () => {
      const a = await request('100');
      const b = await request('200');
      const queue = await admin.queue({});
      expect(queue.map((one) => one.id)).toEqual([a.id, b.id]);
      expect(queue[0]?.identityVerified).toBe(true);
      expect(queue[0]?.email).toBeDefined();
    });

    it('claims, releases, approves, pays', async () => {
      const view = await request('250');
      const claimed = await admin.claim({ id: view.id, actorId: financeId });
      expect(claimed.status).toBe(WithdrawalStatus.UNDER_REVIEW);
      const released = await admin.release({ id: view.id, actorId: financeId });
      expect(released.status).toBe(WithdrawalStatus.REQUESTED);
      const approved = await admin.decide({
        id: view.id,
        outcome: 'APPROVED',
        reason: 'Name and account match the verified identity.',
        actorId: financeId,
      });
      expect(approved.status).toBe(WithdrawalStatus.APPROVED);
      expect(approved.approvedById).toBe(financeId);

      // Approved is not paid: the person cannot cancel, and nothing has moved.
      await expect(
        withdrawals.cancel({ userId, id: view.id, idempotencyKey: 'x' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_STATE_TRANSITION });
      expect(await balance()).toBe('750.00');

      // Cannot be paid without first being started, with a reference.
      await expect(
        admin.settle({ id: view.id, outcome: 'PAID', reason: 'Sent.', actorId: financeId }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_STATE_TRANSITION });

      const processing = await admin.startPayout({
        id: view.id,
        providerReference: 'TRF-20260901-0042',
        actorId: financeId,
      });
      expect(processing.status).toBe(WithdrawalStatus.PROCESSING);
      // Once the transfer is out, a rejection is no longer possible.
      await expect(
        admin.decide({
          id: view.id,
          outcome: 'REJECTED',
          reason: 'Changed my mind.',
          actorId: financeId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_STATE_TRANSITION });

      const paid = await admin.settle({
        id: view.id,
        outcome: 'PAID',
        reason: 'Sent.',
        actorId: financeId,
      });
      expect(paid.providerReference).toBe('TRF-20260901-0042');
      expect(paid.paidById).toBe(financeId);
    });

    it('takes an approval back before the payout starts, and the money returns', async () => {
      const view = await request('250');
      await admin.decide({
        id: view.id,
        outcome: 'APPROVED',
        reason: 'Checked.',
        actorId: financeId,
      });
      const rejected = await admin.decide({
        id: view.id,
        outcome: 'REJECTED',
        reason: 'A second look found the account belongs to somebody else.',
        actorId: financeId,
      });
      expect(rejected.status).toBe(WithdrawalStatus.REJECTED);
      expect(await balance()).toBe('1000.00');
    });

    it('refuses a decision when somebody else wrote between its read and its write', async () => {
      const view = await request('250');
      const interleaving = new Proxy(prisma as unknown as PrismaService, {
        get(target, property, receiver) {
          if (property !== 'withdrawalRequest') return Reflect.get(target, property, receiver);
          const model = Reflect.get(target, property, receiver) as {
            updateMany: (args: unknown) => Promise<unknown>;
          };
          return new Proxy(model, {
            get(inner, name, innerReceiver) {
              if (name !== 'updateMany') return Reflect.get(inner, name, innerReceiver);
              return async (args: unknown) => {
                await prisma.$executeRaw`UPDATE withdrawal_requests SET version = version + 1 WHERE id = ${view.id}::uuid`;
                return inner.updateMany(args);
              };
            },
          });
        },
      });
      const contested = new AdminWithdrawalsService(
        interleaving,
        withdrawals,
        kyc,
        new AuditService(prisma as unknown as PrismaService),
        secrets as SecretBoxService,
        { raise: () => Promise.resolve() } as unknown as NotificationsService,
      );
      await expect(
        contested.decide({
          id: view.id,
          outcome: 'APPROVED',
          reason: 'Checked.',
          actorId: financeId,
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.CONCURRENT_MODIFICATION });
      const after = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: view.id } });
      expect(after.status).toBe(WithdrawalStatus.REQUESTED);
    });

    it('rolls the refund back when somebody else closed the request first', async () => {
      /**
       * The release path — cancel, reject, fail — credits the wallet and
       * closes the row in one transaction. If another writer got to the row
       * between this one's read and its write, the credit must go with the
       * refused write: a refund that stayed after its request was found already
       * closed would be money given back twice.
       */
      const view = await request('250');
      const interleaving = new Proxy(prisma as unknown as PrismaService, {
        get(target, property, receiver) {
          if (property !== '$transaction') return Reflect.get(target, property, receiver);
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            (target as unknown as PrismaClient).$transaction(async (tx) => {
              const wrapped = new Proxy(tx, {
                get(inner, name, innerReceiver) {
                  if (name !== 'withdrawalRequest') return Reflect.get(inner, name, innerReceiver);
                  const model = Reflect.get(inner, name, innerReceiver) as {
                    updateMany: (args: unknown) => Promise<unknown>;
                  };
                  return new Proxy(model, {
                    get(m, key, mReceiver) {
                      if (key !== 'updateMany') return Reflect.get(m, key, mReceiver);
                      return async (args: unknown) => {
                        // Another writer, outside this transaction, moves the row on.
                        await prisma.$executeRaw`UPDATE withdrawal_requests SET version = version + 1 WHERE id = ${view.id}::uuid`;
                        return m.updateMany(args);
                      };
                    },
                  });
                },
              });
              return fn(wrapped);
            });
        },
      });
      const contested = new WithdrawalsService(
        interleaving,
        wallets,
        kyc,
        new AuditService(prisma as unknown as PrismaService),
        secrets as SecretBoxService,
        configure(),
      );

      await expect(
        contested.cancel({ userId, id: view.id, idempotencyKey: 'contested' }),
      ).rejects.toMatchObject({ code: TradingErrorCode.CONCURRENT_MODIFICATION });

      // The credit went with the refused write: the hold still stands.
      expect(await balance()).toBe('750.00');
      const after = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: view.id } });
      expect(after.status).toBe(WithdrawalStatus.REQUESTED);
      expect(after.releaseTransactionId).toBeNull();
    });

    it('auto-approves below the threshold, and still needs a person to pay', async () => {
      const lenient = build({ WITHDRAWAL_AUTO_APPROVE_BELOW: '300' });
      const small = await lenient.service.request({
        userId,
        walletId,
        amount: '250',
        destination: 'GB29 NWBK 6016 1331 9268 19',
        idempotencyKey: 'small',
      });
      expect(small.status).toBe(WithdrawalStatus.APPROVED);
      const big = await lenient.service.request({
        userId,
        walletId,
        amount: '300',
        destination: 'GB29 NWBK 6016 1331 9268 19',
        idempotencyKey: 'big',
      });
      expect(big.status).toBe(WithdrawalStatus.REQUESTED);
      const row = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: small.id } });
      expect(row.autoApproved).toBe(true);
      expect(row.approvedById).toBeNull();
    });

    it('refuses a status nobody defined', async () => {
      await expect(admin.queue({ status: 'DONE' })).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
    });
  });

  describe('at the database', () => {
    beforeEach(verify);

    it('will not let what was asked for be edited, or the row deleted', async () => {
      const view = await request('250');
      await expect(
        prisma.withdrawalRequest.update({ where: { id: view.id }, data: { amount: '1' } }),
      ).rejects.toThrow(/cannot be edited/);
      await expect(prisma.withdrawalRequest.delete({ where: { id: view.id } })).rejects.toThrow(
        /never deleted/,
      );
    });

    /**
     * The hold has to be a movement that happened, in this wallet, in this firm.
     *
     * `hold_transaction_id` was a bare `uuid` column with no foreign key of any
     * kind. Both of these were accepted by the database before the composite
     * key went in:
     *
     *   - a withdrawal naming a movement that does not exist at all;
     *   - a withdrawal in one wallet naming a movement from *another* wallet —
     *     money held from one person and paid to another.
     *
     * Neither is reachable through `request`, which writes the hold and the row
     * in one transaction and takes the id from the movement it just made. That
     * is the whole reason to constrain it: the service is what stands between
     * these rows and the ledger today, and the second case costs somebody their
     * money the first time a refactor gets it wrong.
     *
     * Written as raw SQL on purpose. The point is what the *database* accepts,
     * and going through Prisma's relation would only prove that the generated
     * client requires a field.
     */
    const insertWithdrawal = (over: {
      walletId: string;
      holdTransactionId: string;
    }): Promise<unknown> =>
      prisma.$executeRawUnsafe(
        `INSERT INTO withdrawal_requests
           (id, tenant_id, user_id, wallet_id, amount, currency, status, destination,
            destination_hint, hold_transaction_id, provider, created_at, updated_at)
         SELECT gen_random_uuid(), tenant_id, $1::uuid, $2::uuid, 10, 'USD', 'REQUESTED',
                'sealed', '0000', $3::uuid, 'manual', now(), now()
         FROM users WHERE id = $1::uuid`,
        userId,
        over.walletId,
        over.holdTransactionId,
      );

    it('refuses a withdrawal whose hold never happened', async () => {
      await expect(
        insertWithdrawal({
          walletId,
          holdTransactionId: '00000000-0000-4000-8000-0000000000ff',
        }),
      ).rejects.toThrow(/foreign key/i);
    });

    it('refuses a withdrawal whose hold belongs to a different wallet', async () => {
      // A second wallet for the same person — the cheapest way to have a
      // movement that genuinely exists and genuinely is not this wallet's. The
      // firm is in the key for the same reason, one level out.
      const other = await wallets.ensure(userId, 'EUR');
      const funded = await wallets.adjust({
        walletId: other.id,
        type: 'DEPOSIT',
        amount: '100',
        reason: 'a movement in the wrong wallet',
        idempotencyKey: `other-${Math.random()}`,
        actorId: financeId,
      });
      const movement = await prisma.walletTransaction.findFirstOrThrow({
        where: { walletId: other.id },
      });
      expect(funded.id).toBe(other.id);

      await expect(
        insertWithdrawal({ walletId, holdTransactionId: movement.id }),
        'the movement exists, so only the wallet in the composite key can catch this',
      ).rejects.toThrow(/foreign key/i);
    });

    it('still accepts the hold the service actually writes', async () => {
      // The other half: a constraint that refused the real path would be worse
      // than no constraint, and `request` is the only thing that writes these.
      const view = await request('250');
      const row = await prisma.withdrawalRequest.findFirstOrThrow({ where: { id: view.id } });
      const hold = await prisma.walletTransaction.findFirstOrThrow({
        where: { id: row.holdTransactionId },
      });
      expect(hold.walletId).toBe(row.walletId);
      expect(hold.amount.toString()).toBe('-250');
    });
  });
});
