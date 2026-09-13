import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { withTenant } from '@tp/tenancy';
import { LedgerService } from '../../src/accounts/ledger.service';
import { WalletService } from '../../src/wallet/wallet.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * A value one firm's caller chose must not decide what another firm's caller
 * may do.
 *
 * ## The bug, reproduced before it was fixed
 *
 * Seven columns on tenant-scoped tables carried a **global** `@unique`. A
 * unique index is enforced across every row in the table, *including the rows
 * row-level security hides* — so when Firm B posted an order with
 * `clientOrderId: 'order-1'`, and Firm A had already used it, PostgreSQL
 * refused Firm B:
 *
 *     { code: 'P2002', meta: { modelName: 'Order', target: ['client_order_id'] } }
 *
 * For a row Firm B cannot see, cannot query, and cannot be told about. Two
 * separate failures in one: a denial of service any firm could inflict on
 * another by accident (`order-1` is not an exotic choice), and an **oracle** —
 * the refusal itself answers "did somebody else use this value?", which is the
 * class of leak tenancy exists to close.
 *
 * ## Both halves, always
 *
 * Scoping alone is not the property worth having: dropping the constraint
 * entirely would also let both firms through, and would let a retried webhook
 * credit an account twice. So every case here asserts **both** — that two firms
 * may share a key, and that one firm still cannot reuse its own.
 *
 * `scripts/tenant-unique-keys.test.ts` is the other side of this: it reads
 * `schema.prisma` and fails when a new unique index is added that is not rooted
 * in a tenant. That check catches the next one; this one proves the rule
 * actually holds in the database, against the real constraint, through the real
 * services.
 */
suite('a caller-chosen key is unique within a firm, not across the platform', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let ledger: LedgerService;
  let wallets: WalletService;

  const alpha = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };
  let beta: { tenantId: string; slug: string };

  /** One account per firm, and a symbol both can trade. */
  let alphaAccount: { userId: string; accountId: string };
  let betaAccount: { userId: string; accountId: string };
  let symbolId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    ledger = stack.ledger;
    wallets = new WalletService(
      prisma as unknown as PrismaService,
      stack.ledger,
      stack.accountState,
      new AuditService(prisma as unknown as PrismaService),
    );

    const betaId = await createTenant(prisma, 'beta-firm', 'beta-firm.example.test');
    beta = { tenantId: betaId, slug: 'beta-firm' };

    alphaAccount = await createAccount(prisma, { balance: '10000', email: 'a@alpha.test' });
    betaAccount = await withTenant(beta, () =>
      createAccount(prisma, { balance: '10000', email: 'b@beta.test', tenantId: betaId }),
    );
    symbolId = (await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } })).id;
  });

  /**
   * The error a duplicate produces, or `null` if there wasn't one.
   *
   * Returned rather than asserted here so each test can say what it expects: a
   * `P2002` for a within-firm reuse, and nothing at all across firms.
   */
  async function attempt(work: () => Promise<unknown>): Promise<string | null> {
    try {
      await work();
      return null;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        const target = (error as { meta?: { target?: unknown } }).meta?.target;
        return `P2002 on ${JSON.stringify(target)}`;
      }
      throw error;
    }
  }

  const order = (accountId: string, clientOrderId: string, tenantId: string) => () =>
    prisma.order.create({
      data: {
        tenantId,
        accountId,
        symbolId,
        side: 'BUY',
        type: 'MARKET',
        volume: '0.10',
        clientOrderId,
      },
    });

  describe('Order.clientOrderId — the reference the caller sends with the order', () => {
    it('lets two firms both use `order-1`', async () => {
      expect(await attempt(order(alphaAccount.accountId, 'order-1', alpha.tenantId))).toBeNull();
      expect(
        await withTenant(beta, () =>
          attempt(order(betaAccount.accountId, 'order-1', beta.tenantId)),
        ),
        'Firm B was refused an order because Firm A used the same client reference. ' +
          'The constraint is reaching across a tenancy boundary.',
      ).toBeNull();
    });

    it('still refuses one firm reusing its own', async () => {
      await order(alphaAccount.accountId, 'order-1', alpha.tenantId)();
      expect(
        await attempt(order(alphaAccount.accountId, 'order-1', alpha.tenantId)),
        'Within one firm a client order id must still be unique — it is the key the ' +
          'venue recovery query asks by, and two orders sharing one cannot be told apart.',
      ).toContain('P2002');
    });

    it('does not treat two absent references as a collision', async () => {
      // A null is not a value, and most orders have no client reference at all.
      // A unique index that counted them would refuse the second order every
      // trader ever placed — worth pinning, because it is the failure a
      // hand-written `CREATE UNIQUE INDEX` gets wrong.
      expect(await attempt(order(alphaAccount.accountId, null as never, alpha.tenantId))).toBeNull();
      expect(await attempt(order(alphaAccount.accountId, null as never, alpha.tenantId))).toBeNull();
    });
  });

  describe('the ids a venue hands us', () => {
    const position = (accountId: string, externalPositionId: string, tenantId: string) => () =>
      prisma.position.create({
        data: {
          tenantId,
          accountId,
          symbolId,
          side: 'BUY',
          volume: '0.10',
          initialVolume: '0.10',
          entryPrice: '2000',
          margin: '20',
          externalPositionId,
        },
      });

    /**
     * Two firms on two brokers can be handed the same id, and often are —
     * broker position ids are small integers, and a firm's sandbox reissues
     * them from 1. Nothing about Firm A's broker constrains Firm B's.
     */
    it('lets two firms both hold venue position `100045`', async () => {
      expect(
        await attempt(position(alphaAccount.accountId, '100045', alpha.tenantId)),
      ).toBeNull();
      expect(
        await withTenant(beta, () =>
          attempt(position(betaAccount.accountId, '100045', beta.tenantId)),
        ),
      ).toBeNull();
    });

    it('still refuses two positions in one firm pointing at one venue position', async () => {
      // Because each would close the other's.
      await position(alphaAccount.accountId, '100045', alpha.tenantId)();
      expect(await attempt(position(alphaAccount.accountId, '100045', alpha.tenantId))).toContain(
        'P2002',
      );
    });

    it('scopes an execution id the same way, and still deduplicates within a firm', async () => {
      const execution =
        (accountId: string, externalExecutionId: string, tenantId: string, orderId: string) =>
        () =>
          prisma.execution.create({
            data: {
              tenantId,
              accountId,
              orderId,
              side: 'BUY',
              volume: '0.10',
              price: '2000',
              quoteBid: '1999.5',
              quoteAsk: '2000.5',
              quoteAt: new Date(),
              externalExecutionId,
            },
          });

      const alphaOrder = await order(alphaAccount.accountId, 'a-1', alpha.tenantId)();
      const betaOrder = await withTenant(beta, () =>
        order(betaAccount.accountId, 'b-1', beta.tenantId)(),
      );

      expect(
        await attempt(
          execution(alphaAccount.accountId, 'fill-9', alpha.tenantId, alphaOrder.id),
        ),
      ).toBeNull();
      expect(
        await withTenant(beta, () =>
          attempt(execution(betaAccount.accountId, 'fill-9', beta.tenantId, betaOrder.id)),
        ),
      ).toBeNull();
      // A redelivered event from *this* firm's venue must still not book twice.
      expect(
        await attempt(
          execution(alphaAccount.accountId, 'fill-9', alpha.tenantId, alphaOrder.id),
        ),
      ).toContain('P2002');
    });
  });

  describe('BalanceLedger.idempotencyKey — through the service that reads it', () => {
    const deposit = (accountId: string, key: string) =>
      prisma.$transaction((tx) =>
        ledger.post(tx, {
          accountId,
          type: 'DEPOSIT',
          amount: Money.of('500', 'USD'),
          idempotencyKey: key,
          description: 'bank transfer',
        }),
      );

    /**
     * Inside the firm that owns the account, because reading it from the other
     * one finds nothing — which this test proved the hard way on its first run,
     * and is exactly the isolation everything here depends on.
     */
    const balance = async (
      scope: { tenantId: string; slug: string },
      accountId: string,
    ): Promise<string> =>
      withTenant(scope, async () =>
        (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance.toString(),
      );

    /**
     * The case `docs/database.md` described and nothing checked.
     *
     * Both firms are paid, and each is paid once. A global unique gave the
     * first firm its money and refused the second; no unique at all would pay
     * both of them twice.
     */
    it('pays both firms, and pays each of them once', async () => {
      await deposit(alphaAccount.accountId, 'payout-42');
      await withTenant(beta, () => deposit(betaAccount.accountId, 'payout-42'));

      expect(Number(await balance(alpha, alphaAccount.accountId))).toBe(10_500);
      expect(Number(await balance(beta, betaAccount.accountId))).toBe(10_500);

      // The retry that made this a guarantee in the first place.
      const replay = await deposit(alphaAccount.accountId, 'payout-42');
      expect(Number(await balance(alpha, alphaAccount.accountId))).toBe(10_500);

      const first = await prisma.balanceLedger.findFirstOrThrow({
        where: { idempotencyKey: 'payout-42' },
      });
      // The replay is answered with the original entry, not a new one.
      expect(replay.entryId).toBe(first.id);
      expect(
        await prisma.balanceLedger.count({ where: { idempotencyKey: 'payout-42' } }),
        'one entry per firm — and the count is taken inside Firm A, so it sees only its own',
      ).toBe(1);
    });

    /**
     * The read inside `post`, not just the constraint under it.
     *
     * `post` looks the key up before writing, and that lookup has to name the
     * tenant too. When it did not, the lookup was narrowed by the tenancy
     * extension — correct — but it meant the service went on to attempt an
     * insert the *constraint* then refused, so the failure surfaced as a raw
     * P2002 from deep inside a transaction rather than as anything a caller
     * could act on. Firm B seeing Firm A's row here would be worse still.
     */
    it('does not answer one firm’s retry with another firm’s entry', async () => {
      const alphaEntry = await deposit(alphaAccount.accountId, 'payout-42');
      const betaEntry = await withTenant(beta, () => deposit(betaAccount.accountId, 'payout-42'));
      expect(betaEntry.entryId).not.toBe(alphaEntry.entryId);
    });
  });

  describe('WalletTransaction.idempotencyKey', () => {
    const fund = async (userId: string, key: string) => {
      const wallet = await wallets.ensure(userId, 'USD');
      return wallets.adjust({
        walletId: wallet.id,
        type: 'DEPOSIT',
        amount: '250',
        reason: 'bank transfer seen on the statement',
        idempotencyKey: key,
        actorId: userId,
      });
    };

    it('credits both firms’ wallets on the same key, once each', async () => {
      const alphaWallet = await fund(alphaAccount.userId, 'wallet-top-up-7');
      const betaWallet = await withTenant(beta, () => fund(betaAccount.userId, 'wallet-top-up-7'));
      expect(Number(alphaWallet.balance)).toBe(250);
      expect(Number(betaWallet.balance)).toBe(250);

      const replay = await fund(alphaAccount.userId, 'wallet-top-up-7');
      expect(Number(replay.balance), 'a retry is answered, not re-posted').toBe(250);
    });
  });

  describe('the payment provider’s own references', () => {
    const intent = (userId: string, tenantId: string, reference: string) => () =>
      prisma.paymentIntent.create({
        data: {
          tenantId,
          userId,
          provider: 'stripe',
          providerReference: reference,
          amount: '100',
          currency: 'USD',
          status: 'REQUIRES_ACTION',
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

    /**
     * Each firm has its own merchant account at the provider. A provider's
     * reference is unique within *that* account, not across every account the
     * provider has ever opened — and in a sandbox it is frequently `pi_test_1`.
     */
    it('lets two firms hold the same provider reference', async () => {
      expect(await attempt(intent(alphaAccount.userId, alpha.tenantId, 'pi_test_1'))).toBeNull();
      expect(
        await withTenant(beta, () => attempt(intent(betaAccount.userId, beta.tenantId, 'pi_test_1'))),
      ).toBeNull();
    });

    it('still refuses one firm two intents for one reference', async () => {
      await intent(alphaAccount.userId, alpha.tenantId, 'pi_test_1')();
      expect(
        await attempt(intent(alphaAccount.userId, alpha.tenantId, 'pi_test_1')),
        'within a firm this is the replay guard on the payment itself',
      ).toContain('P2002');
    });

    it('scopes the webhook event id the same way', async () => {
      const alphaIntent = await intent(alphaAccount.userId, alpha.tenantId, 'pi_a')();
      const betaIntent = await withTenant(beta, () =>
        intent(betaAccount.userId, beta.tenantId, 'pi_b')(),
      );
      const event = (intentId: string, tenantId: string) => () =>
        prisma.paymentEvent.create({
          data: {
            tenantId,
            intentId,
            provider: 'stripe',
            providerEventId: 'evt_1',
            providerStatus: 'succeeded',
            status: 'SUCCEEDED',
            outcome: 'apply',
          },
        });

      expect(await attempt(event(alphaIntent.id, alpha.tenantId))).toBeNull();
      expect(await withTenant(beta, () => attempt(event(betaIntent.id, beta.tenantId)))).toBeNull();
      // Redelivery within a firm is still exactly once — the point of the index.
      expect(await attempt(event(alphaIntent.id, alpha.tenantId))).toContain('P2002');
    });
  });
});
