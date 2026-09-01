import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { PaymentStatus } from '@tp/payments-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { toDecimal } from '@tp/financial-core';
import { PaymentsService } from '../../src/payments/payments.service';
import { PaymentProviders } from '../../src/payments/payment-providers';
import { AdminPaymentsService } from '../../src/payments/admin-payments.service';
import { WalletService } from '../../src/wallet/wallet.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { MaintenanceService } from '../../../worker/src/jobs/maintenance.service';
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
 * Money coming in, and the two ways an accounting system loses to a webhook.
 *
 * A provider will deliver the same event twice — after a timeout, after its own
 * outage, after a retry — and it will occasionally deliver an event that does
 * not say what the platform thinks the payment was for. Both of those credit a
 * wallet if nobody stops them, and neither is exotic enough to be a rare case.
 *
 * So most of these tests assert on a *balance after a second thing happened*
 * rather than on a return value. A service that credited twice would satisfy
 * every assertion about the first credit and fail exactly the ones here.
 */
suite('payments', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let wallets: WalletService;
  let payments: PaymentsService;
  let admin: AdminPaymentsService;
  let providers: PaymentProviders;
  let userId: string;
  let email: string;

  const config = (over: Record<string, unknown> = {}): ConfigService<never, true> =>
    new ConfigService<Record<string, unknown>, true>({
      PAYMENT_CURRENCIES: 'USD,EUR',
      PAYMENT_MAX_AMOUNT: '100000',
      PAYMENT_INTENT_TTL_HOURS: 72,
      PAYMENT_BANK_DETAILS: 'Test Bank / IBAN GB00 TEST 0000 0000',
      ...over,
    } as never) as unknown as ConfigService<never, true>;

  /** The wallet balance, as a fixed string so 0 and 0.00 cannot both pass. */
  const balance = async (currency = 'USD'): Promise<string> => {
    const wallet = await prisma.wallet.findFirst({ where: { userId, currency } });
    return toDecimal(wallet?.balance.toString() ?? '0').toFixed(2);
  };

  const deposits = async (): Promise<number> =>
    prisma.walletTransaction.count({ where: { type: 'DEPOSIT' } });

  beforeEach(async () => {
    prisma = createTestClient();
    await resetDatabase(prisma);
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    const created = await createAccount(prisma, { balance: '1000' });
    userId = created.userId;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    email = user.email;

    const audit = new AuditService(prisma as unknown as PrismaService);
    wallets = new WalletService(
      prisma as unknown as PrismaService,
      stack.ledger,
      stack.accountState,
      audit,
    );
    providers = new PaymentProviders(config());
    payments = new PaymentsService(
      prisma as unknown as PrismaService,
      wallets,
      providers,
      audit,
      config(),
    );
    admin = new AdminPaymentsService(prisma as unknown as PrismaService, payments, audit);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const start = async (amount = '500', currency = 'USD') =>
    payments.start({ userId, email, provider: 'manual-bank-transfer', amount, currency });

  const event = (
    reference: string,
    status: PaymentStatus,
    over: Partial<{ eventId: string; amount: string; currency: string }> = {},
  ) => ({
    eventId: over.eventId ?? `evt-${reference}-${status}`,
    reference,
    status,
    providerStatus: `provider said ${status}`,
    ...(over.amount === undefined ? {} : { amount: over.amount }),
    ...(over.currency === undefined ? {} : { currency: over.currency }),
  });

  describe('starting a payment', () => {
    it('records the intent before the payer is told anything', async () => {
      const intent = await start('500');

      expect(intent.status).toBe(PaymentStatus.REQUIRES_ACTION);
      expect(intent.amount).toBe('500.00');
      // The reference the payer is told to quote must be a row that exists.
      const row = await prisma.paymentIntent.findFirst({ where: { id: intent.id } });
      expect(row).not.toBeNull();
      expect(intent.instructions).toContain(intent.id);
    });

    it('shows the configured bank details, never a hard-coded account', async () => {
      const intent = await start();
      expect(intent.instructions).toContain('IBAN GB00 TEST 0000 0000');
    });

    it('says so plainly when no bank details are configured', async () => {
      const bare = new PaymentsService(
        prisma as unknown as PrismaService,
        wallets,
        new PaymentProviders(config({ PAYMENT_BANK_DETAILS: undefined })),
        new AuditService(prisma as unknown as PrismaService),
        config({ PAYMENT_BANK_DETAILS: undefined }),
      );
      const intent = await bare.start({
        userId,
        email,
        provider: 'manual-bank-transfer',
        amount: '10',
        currency: 'USD',
      });
      expect(intent.instructions).toContain('have not been configured');
      expect(intent.instructions).not.toContain('undefined');
    });

    it('creates no money by starting', async () => {
      await start('500');
      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
    });

    it('refuses a currency the provider does not take', async () => {
      await expect(start('500', 'JPY')).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
      expect(await prisma.paymentIntent.count()).toBe(0);
    });

    it('refuses a deposit that is not positive', async () => {
      for (const amount of ['0', '-1']) {
        await expect(start(amount)).rejects.toBeInstanceOf(DomainError);
      }
      expect(await prisma.paymentIntent.count()).toBe(0);
    });

    it('refuses a deposit above the configured ceiling', async () => {
      await expect(start('100000.01')).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
      // Exactly the ceiling is allowed; a boundary that refused it would be wrong.
      await expect(start('100000')).resolves.toMatchObject({ amount: '100000.00' });
    });

    it('refuses a provider this deployment does not have', async () => {
      await expect(
        payments.start({
          userId,
          email,
          provider: 'stripe',
          amount: '10',
          currency: 'USD',
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.VALIDATION_FAILED });
    });
  });

  describe('a payment becoming money', () => {
    it('credits the wallet exactly once on success', async () => {
      const intent = await start('500');
      await payments.apply('manual-bank-transfer', event(intent.id, PaymentStatus.SUCCEEDED));

      expect(await balance()).toBe('500.00');
      expect(await deposits()).toBe(1);
      const after = await prisma.paymentIntent.findFirstOrThrow({ where: { id: intent.id } });
      expect(after.status).toBe(PaymentStatus.SUCCEEDED);
      expect(after.settledAt).not.toBeNull();
      expect(after.walletTransactionId).not.toBeNull();

      /**
       * The delivery that moved the money is written down, with the provider's
       * own id on it. That row is the first thing an operator reconciling a
       * disputed deposit looks for, and it is what the unique constraint acts
       * on — a credit that left no event behind is a credit nothing can stop
       * from happening a second time.
       */
      const applied = await prisma.paymentEvent.findMany({ where: { intentId: intent.id } });
      expect(applied).toHaveLength(1);
      expect(applied[0]?.outcome).toBe('apply');
      expect(applied[0]?.providerEventId).toBe(`evt-${intent.id}-SUCCEEDED`);
      expect(applied[0]?.providerStatus).toContain('SUCCEEDED');
    });

    it('credits once when the provider re-delivers the same event', async () => {
      const intent = await start('500');
      const delivery = event(intent.id, PaymentStatus.SUCCEEDED);

      await payments.apply('manual-bank-transfer', delivery);
      await payments.apply('manual-bank-transfer', delivery);
      await payments.apply('manual-bank-transfer', delivery);

      expect(await balance()).toBe('500.00');
      expect(await deposits()).toBe(1);
      // One delivery, recorded once: the unique (provider, event id) held.
      expect(await prisma.paymentEvent.count({ where: { intentId: intent.id } })).toBe(1);
    });

    it('credits once even when the repeat carries a new event id', async () => {
      /**
       * The case the unique constraint alone does not catch. A provider that
       * invents a fresh id for a retry gets past `(provider, event_id)`, and
       * only the wallet's own idempotency key stops the second credit.
       */
      const intent = await start('500');
      await payments.apply(
        'manual-bank-transfer',
        event(intent.id, PaymentStatus.SUCCEEDED, { eventId: 'first' }),
      );
      await payments.apply(
        'manual-bank-transfer',
        event(intent.id, PaymentStatus.SUCCEEDED, { eventId: 'second' }),
      );

      expect(await balance()).toBe('500.00');
      expect(await deposits()).toBe(1);
    });

    it('credits once under two deliveries racing each other', async () => {
      /**
       * The case neither guard catches alone, and the reason both exist.
       *
       * Two deliveries with *different* event ids, both reading the intent
       * before either has written: the unique `(provider, event_id)` does not
       * collide, and the state machine sees `REQUIRES_ACTION` twice. Only the
       * wallet's own idempotency key is left between that and a double credit.
       *
       * The wallet is created first on purpose. An earlier version of this test
       * raced wallet *creation* as well, one side lost on the unique index, and
       * the rejection it produced hid the double credit the test was written to
       * catch — it passed with the idempotency key deleted.
       */
      const intent = await start('500');
      await wallets.ensure(userId, 'USD');

      const results = await Promise.allSettled([
        payments.apply(
          'manual-bank-transfer',
          event(intent.id, PaymentStatus.SUCCEEDED, { eventId: 'race-a' }),
        ),
        payments.apply(
          'manual-bank-transfer',
          event(intent.id, PaymentStatus.SUCCEEDED, { eventId: 'race-b' }),
        ),
      ]);

      // Both deliveries are legitimate; neither may be answered with an error.
      const rejected = results.filter((one) => one.status === 'rejected');
      expect(rejected.map((one) => String((one as PromiseRejectedResult).reason))).toEqual([]);
      expect(await balance()).toBe('500.00');
      expect(await deposits()).toBe(1);
    });

    it('gives one wallet to two things asking for it at the same moment', async () => {
      const results = await Promise.allSettled([
        wallets.ensure(userId, 'USD'),
        wallets.ensure(userId, 'USD'),
        wallets.ensure(userId, 'USD'),
      ]);

      const rejected = results.filter((one) => one.status === 'rejected');
      expect(rejected.map((one) => String((one as PromiseRejectedResult).reason))).toEqual([]);
      const ids = new Set(
        results.map((one) => (one as PromiseFulfilledResult<{ id: string }>).value.id),
      );
      expect(ids.size).toBe(1);
      expect(await prisma.wallet.count({ where: { userId, currency: 'USD' } })).toBe(1);
    });

    it('leaves the intent in one piece when the credit fails', async () => {
      const intent = await start('500');
      const broken = new PaymentsService(
        prisma as unknown as PrismaService,
        {
          ensure: wallets.ensure.bind(wallets),
          post: () => Promise.reject(new Error('ledger unavailable')),
        } as unknown as WalletService,
        providers,
        new AuditService(prisma as unknown as PrismaService),
        config(),
      );

      await expect(
        broken.apply('manual-bank-transfer', event(intent.id, PaymentStatus.SUCCEEDED)),
      ).rejects.toThrow('ledger unavailable');

      // Nothing half-applied: no money, and the payment is still awaiting one.
      expect(await balance()).toBe('0.00');
      const after = await prisma.paymentIntent.findFirstOrThrow({ where: { id: intent.id } });
      expect(after.status).toBe(PaymentStatus.REQUIRES_ACTION);
      // The event row rolled back with it, so the retry is not mistaken for a repeat.
      expect(await prisma.paymentEvent.count({ where: { intentId: intent.id } })).toBe(0);
    });
  });

  describe('a payment that does not become money', () => {
    it('creates no funds when the payment fails', async () => {
      const intent = await start('500');
      await payments.apply('manual-bank-transfer', event(intent.id, PaymentStatus.FAILED));

      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
      const after = await prisma.paymentIntent.findFirstOrThrow({ where: { id: intent.id } });
      expect(after.status).toBe(PaymentStatus.FAILED);
      expect(after.failureReason).not.toBeNull();
      expect(after.settledAt).toBeNull();
    });

    it('creates no funds when a failed payment is then reported successful', async () => {
      const intent = await start('500');
      await payments.apply('manual-bank-transfer', event(intent.id, PaymentStatus.FAILED));
      await payments.apply('manual-bank-transfer', event(intent.id, PaymentStatus.SUCCEEDED));

      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
    });

    it('does not un-credit a settled payment reported as failed, and says so loudly', async () => {
      const intent = await start('500');
      await payments.apply('manual-bank-transfer', event(intent.id, PaymentStatus.SUCCEEDED));
      await payments.apply(
        'manual-bank-transfer',
        event(intent.id, PaymentStatus.FAILED, { eventId: 'reversal' }),
      );

      /**
       * A settled payment does not un-settle. A genuine reversal is a chargeback,
       * which is a separate movement with its own accounting — silently debiting
       * a wallet from a webhook is how money disappears with no record of anyone
       * deciding it should.
       */
      expect(await balance()).toBe('500.00');
      const after = await prisma.paymentIntent.findFirstOrThrow({ where: { id: intent.id } });
      expect(after.status).toBe(PaymentStatus.SUCCEEDED);

      const alarm = await prisma.paymentEvent.findFirst({
        where: { intentId: intent.id, outcome: 'alarm' },
      });
      expect(alarm).not.toBeNull();
      expect(alarm?.note ?? '').not.toBe('');
    });

    it('credits nothing when the provider states a different amount', async () => {
      const intent = await start('500');
      await payments.apply(
        'manual-bank-transfer',
        event(intent.id, PaymentStatus.SUCCEEDED, { amount: '5000' }),
      );

      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
      const after = await prisma.paymentIntent.findFirstOrThrow({ where: { id: intent.id } });
      expect(after.status).toBe(PaymentStatus.REQUIRES_ACTION);
      const alarm = await prisma.paymentEvent.findFirst({
        where: { intentId: intent.id, outcome: 'alarm' },
      });
      expect(alarm?.note ?? '').toContain('5000');
    });

    it('accepts a stated amount that matches, whatever its trailing zeros', async () => {
      const intent = await start('500');
      await payments.apply(
        'manual-bank-transfer',
        event(intent.id, PaymentStatus.SUCCEEDED, { amount: '500.0000' }),
      );
      expect(await balance()).toBe('500.00');
    });

    it('credits nothing for a reference that is not a payment here', async () => {
      await start('500');
      await payments.apply(
        'manual-bank-transfer',
        event('00000000-0000-4000-8000-00000000dead', PaymentStatus.SUCCEEDED),
      );
      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
    });

    it('credits nothing when the event names a different provider', async () => {
      const intent = await start('500');
      await payments.apply('some-other-provider', event(intent.id, PaymentStatus.SUCCEEDED));
      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
    });
  });

  describe('webhooks', () => {
    it('ignores a delivery for a provider this deployment does not have', async () => {
      await expect(
        payments.handleWebhook('stripe', { headers: {}, body: '{}' }),
      ).resolves.toBeUndefined();
      expect(await deposits()).toBe(0);
    });

    it('ignores a delivery the adapter does not vouch for', async () => {
      const intent = await start('500');
      // The manual provider has no webhook: nothing it is sent is authentic.
      await payments.handleWebhook('manual-bank-transfer', {
        headers: { 'x-signature': 'forged' },
        body: JSON.stringify({ reference: intent.id, status: 'SUCCEEDED' }),
      });

      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
    });
  });

  describe('an operator confirming a transfer', () => {
    it('credits the wallet through the same door a webhook uses', async () => {
      const intent = await start('500');
      const after = await admin.settleByHand({
        intentId: intent.id,
        outcome: 'SUCCEEDED',
        reason: 'seen on the bank statement',
        actorId: userId,
        idempotencyKey: 'op-1',
      });

      expect(after.status).toBe(PaymentStatus.SUCCEEDED);
      expect(await balance()).toBe('500.00');
      const trail = await prisma.auditLog.findFirst({
        where: { resourceId: intent.id, action: 'payment.settled_by_hand' },
      });
      expect(trail).not.toBeNull();
      expect(trail?.actorId).toBe(userId);
    });

    it('credits once when the operator presses confirm twice', async () => {
      const intent = await start('500');
      const once = {
        intentId: intent.id,
        outcome: 'SUCCEEDED' as const,
        reason: 'seen on the bank statement',
        actorId: userId,
        idempotencyKey: 'op-1',
      };
      await admin.settleByHand(once);
      await admin.settleByHand(once);

      expect(await balance()).toBe('500.00');
      expect(await deposits()).toBe(1);
    });

    it('refuses a payment that does not exist', async () => {
      await expect(
        admin.settleByHand({
          intentId: '00000000-0000-4000-8000-00000000beef',
          outcome: 'SUCCEEDED',
          reason: 'x',
          actorId: userId,
          idempotencyKey: 'op-2',
        }),
      ).rejects.toMatchObject({ code: TradingErrorCode.RESOURCE_NOT_FOUND });
    });

    it('refuses a status nobody defined rather than listing nothing', async () => {
      await expect(admin.list({ status: 'DEFINITELY_PAID' })).rejects.toMatchObject({
        code: TradingErrorCode.VALIDATION_FAILED,
      });
    });
  });

  describe('reading payments back', () => {
    it('will not show one person the payment of another', async () => {
      const intent = await start('500');
      const other = await createAccount(prisma, { balance: '0' });

      await expect(payments.get(other.userId, intent.id)).rejects.toMatchObject({
        code: TradingErrorCode.RESOURCE_NOT_FOUND,
      });
      expect(await payments.listFor(other.userId)).toHaveLength(0);
      expect(await payments.listFor(userId)).toHaveLength(1);
    });

    it('reports every amount in one shape', async () => {
      const intent = await start('500');
      const [listed] = await payments.listFor(userId);
      const fetched = await payments.get(userId, intent.id);
      expect(listed?.amount).toBe('500.00');
      expect(fetched.amount).toBe('500.00');
    });
  });

  describe('payments nobody paid', () => {
    it('expires an unpaid payment past its window, and nothing else', async () => {
      const unpaid = await start('500');
      const paid = await start('100');
      await payments.apply('manual-bank-transfer', event(paid.id, PaymentStatus.SUCCEEDED));

      // Both are old enough; only one of them is still waiting for money.
      await prisma.paymentIntent.updateMany({
        data: { expiresAt: new Date(Date.now() - 3_600_000) },
      });

      const maintenance = new MaintenanceService(prisma as never);
      expect(await maintenance.expireStalePayments()).toBe(1);

      const after = await prisma.paymentIntent.findFirstOrThrow({ where: { id: unpaid.id } });
      expect(after.status).toBe(PaymentStatus.EXPIRED);
      const settled = await prisma.paymentIntent.findFirstOrThrow({ where: { id: paid.id } });
      expect(settled.status).toBe(PaymentStatus.SUCCEEDED);
      // A clock must never un-arrive money that arrived.
      expect(await balance()).toBe('100.00');
    });

    it('leaves a payment inside its window alone', async () => {
      await start('500');
      const maintenance = new MaintenanceService(prisma as never);
      expect(await maintenance.expireStalePayments()).toBe(0);
    });

    it('creates no money out of an expired payment later reported successful', async () => {
      const intent = await start('500');
      await prisma.paymentIntent.updateMany({
        data: { expiresAt: new Date(Date.now() - 3_600_000) },
      });
      await new MaintenanceService(prisma as never).expireStalePayments();

      await payments.apply('manual-bank-transfer', event(intent.id, PaymentStatus.SUCCEEDED));

      /**
       * Expiry is terminal. A transfer that genuinely arrived after the window
       * closed is an operator's decision — a new payment, or a manual credit
       * with a name against it — not something a late webhook does by itself.
       */
      expect(await balance()).toBe('0.00');
      expect(await deposits()).toBe(0);
    });
  });
});
