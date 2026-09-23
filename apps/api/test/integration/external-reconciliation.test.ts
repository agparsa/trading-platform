import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MockBrokerAdapter, type BrokerCredentials } from '@tp/broker-sdk';
import { withTenant } from '@tp/tenancy';
import { ExternalReconciliationService } from '../../src/reconciliation/external-reconciliation.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

const CREDENTIALS: BrokerCredentials = {
  kind: 'LOGIN_PASSWORD_SERVER',
  fields: { login: '1001', password: 'correct-horse-battery', server: 'Mock-Live' },
};

/**
 * The platform's records against a venue's (§44).
 *
 * The property worth protecting above all others is the last block: an
 * unreachable venue must conclude nothing. Everything else here is arithmetic
 * that `@tp/reconciliation-core` already proves; these tests are about the
 * wiring — that the right rows are read, that only disagreements are stored,
 * and that a resolution is a record rather than an edit.
 */
suite('external reconciliation', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let service: ExternalReconciliationService;
  let connectionId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);

    const actor = await createAccount(prisma, { balance: '0' });
    actorId = actor.userId;

    await withTenant(TENANT, async () => {
      const connection = await stack.connections.create(actorId, {
        name: 'Mock venue',
        adapterKind: 'MOCK',
      });
      connectionId = connection.id;
      await stack.connections.setCredentials(actorId, connectionId, CREDENTIALS);
      await stack.mappings.map(actorId, connectionId, {
        symbolCode: 'XAUUSD',
        externalSymbol: 'XAUUSD.m',
      });
    });

    service = new ExternalReconciliationService(
      prisma as unknown as PrismaService,
      stack.connections,
      stack.accountState,
      new AuditService(prisma as unknown as PrismaService),
    );
  });

  /** Registers an adapter the next connection will build, so a test can script it. */
  const scriptVenue = (adapter: MockBrokerAdapter): MockBrokerAdapter => {
    stack.registry.register({
      kind: 'MOCK',
      displayName: 'Mock venue (testing only)',
      documentation: '',
      credentialFields: [
        { key: 'login', label: 'Login', secret: false },
        { key: 'password', label: 'Password', secret: true },
        { key: 'server', label: 'Server', secret: false },
      ],
      create: () => adapter,
    });
    return adapter;
  };

  const externalAccount = async (balance = '100000') => {
    const { userId, accountId } = await createAccount(prisma, { balance });
    await prisma.account.update({
      where: { id: accountId },
      data: {
        executionMode: 'EXTERNAL_BROKER',
        brokerConnectionId: connectionId,
        externalAccountId: 'MOCK-1001',
      },
    });
    return { userId, accountId };
  };

  const run = (over: Record<string, unknown> = {}) =>
    withTenant(TENANT, () =>
      service.run({ connectionId, trigger: 'MANUAL', requestedByUserId: actorId, ...over }),
    );

  it('records a run even when it finds nothing', async () => {
    scriptVenue(new MockBrokerAdapter({ latencyMs: 0 }));
    const summary = await run();

    const row = await prisma.reconciliationRun.findUniqueOrThrow({
      where: { id: summary.runId },
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.kind).toBe('EXTERNAL');
    expect(row.brokerConnectionId).toBe(connectionId);
    expect(row.finishedAt).not.toBeNull();
  });

  /**
   * The whole point of §44's balance comparison, and the cheapest thing to get
   * wrong: the platform believes 100,000 and the venue has never heard of the
   * account's money.
   */
  it('reports a balance the venue disagrees with', async () => {
    const venue = scriptVenue(new MockBrokerAdapter({ latencyMs: 0 }));
    venue.seedAccount({ externalAccountId: 'MOCK-1001', currency: 'USD', balance: '99999.99' });
    await externalAccount('100000');

    const summary = await run();
    expect(summary.mismatched).toBeGreaterThan(0);

    const item = await prisma.reconciliationItem.findFirstOrThrow({
      where: { runId: summary.runId, subject: 'BALANCE', field: 'balance' },
    });
    expect(item.status).toBe('BALANCE_MISMATCH');
    expect(item.internal).toBe('100000');
    expect(item.external).toBe('99999.99');
    expect(item.difference).toBe('0.01');
  });

  /**
   * A matched order is a row the platform would write on every run for the life
   * of the account. The count says what those rows would have said.
   */
  it('stores only disagreements, and counts the rest', async () => {
    const venue = scriptVenue(new MockBrokerAdapter({ latencyMs: 0 }));
    venue.seedAccount({ externalAccountId: 'MOCK-1001', currency: 'USD', balance: '100000' });
    await externalAccount('100000');

    const summary = await run();

    expect(summary.compared).toBeGreaterThan(0);
    expect(summary.matched).toBe(summary.compared);
    expect(await prisma.reconciliationItem.count({ where: { runId: summary.runId } })).toBe(0);
  });

  /** The venue holds a position nobody here booked. */
  it('reports a position the venue has and this platform does not', async () => {
    const venue = scriptVenue(new MockBrokerAdapter({ latencyMs: 0 }));
    venue.seedAccount({ externalAccountId: 'MOCK-1001', currency: 'USD', balance: '100000' });
    venue.seedPosition({
      externalPositionId: 'VP-1',
      externalAccountId: 'MOCK-1001',
      externalSymbol: 'XAUUSD.m',
      side: 'BUY',
      volume: '1.00',
      entryPrice: '4583.58',
      stopLoss: null,
      takeProfit: null,
      openedAt: new Date(),
    });
    await externalAccount('100000');

    const summary = await run();
    const item = await prisma.reconciliationItem.findFirstOrThrow({
      where: { runId: summary.runId, subject: 'POSITION' },
    });
    expect(item.status).toBe('MISSING_INTERNAL');
    expect(item.external).toBe('VP-1');
    expect(summary.missing).toBe(1);
  });

  /**
   * **The rule this component exists to obey.**
   *
   * A venue that cannot be reached has not told us our orders are missing. It
   * has told us nothing. Writing MISSING_EXTERNAL for every order in that case
   * would produce a report saying the firm's entire book is unbacked, on the
   * day the network was bad — and somebody would act on it.
   */
  describe('when the venue cannot be reached', () => {
    const unreachable = () => {
      const adapter = new MockBrokerAdapter({ latencyMs: 0 });
      // Every read fails, the way a connection that has dropped does.
      const fail = () => Promise.reject(new Error('connection reset by peer'));
      Object.assign(adapter, {
        getAccount: fail,
        getOrders: fail,
        getPositions: fail,
        getExecutions: fail,
      });
      return scriptVenue(adapter);
    };

    it('concludes nothing, and writes no items', async () => {
      unreachable();
      await externalAccount('100000');

      const summary = await run();

      expect(summary.unreachable).toBe(1);
      expect(summary.accountsChecked).toBe(0);
      expect(summary.missing).toBe(0);
      expect(summary.mismatched).toBe(0);
      expect(await prisma.reconciliationItem.count({ where: { runId: summary.runId } })).toBe(0);
    });

    /**
     * And the run still completes and is recorded. "We could not look" is a
     * fact an operator needs; a run that vanished would look like a run that
     * never happened.
     */
    it('still records the run, so the silence is visible', async () => {
      unreachable();
      await externalAccount('100000');

      const summary = await run();
      const row = await prisma.reconciliationRun.findUniqueOrThrow({
        where: { id: summary.runId },
      });
      expect(row.status).toBe('COMPLETED');
      expect(row.accountsChecked).toBe(0);
    });
  });

  describe('resolutions', () => {
    const anItem = async () => {
      const venue = scriptVenue(new MockBrokerAdapter({ latencyMs: 0 }));
      venue.seedAccount({ externalAccountId: 'MOCK-1001', currency: 'USD', balance: '1' });
      await externalAccount('100000');
      const summary = await run();
      return prisma.reconciliationItem.findFirstOrThrow({ where: { runId: summary.runId } });
    };

    it('records what a person decided, and why', async () => {
      const item = await anItem();
      const record = await withTenant(TENANT, () =>
        service.resolve({
          userId: actorId,
          itemId: item.id,
          decision: 'ACCEPTED_DIFFERENCE',
          note: 'The venue books swap a day later; expected until they change it.',
        }),
      );

      const row = await prisma.resolutionRecord.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.decision).toBe('ACCEPTED_DIFFERENCE');
      expect(row.decidedByUserId).toBe(actorId);
      expect(row.note).toMatch(/swap a day later/);
    });

    /**
     * The item's status is what the machine observed and stays what it
     * observed. A resolution is a separate statement about it, not an edit of
     * it — otherwise the evidence and the conclusion overwrite each other.
     */
    it('does not change what the machine observed', async () => {
      const item = await anItem();
      await withTenant(TENANT, () =>
        service.resolve({
          userId: actorId,
          itemId: item.id,
          decision: 'FALSE_POSITIVE',
          note: 'Ours was right; the venue had not settled.',
        }),
      );

      const after = await prisma.reconciliationItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after.status).toBe(item.status);
      expect(after.internal).toBe(item.internal);
      expect(after.external).toBe(item.external);
    });

    /** A discrepancy accepted, then reopened, is two records — not one mind changing. */
    it('keeps every decision rather than the latest one', async () => {
      const item = await anItem();
      await withTenant(TENANT, () =>
        service.resolve({
          userId: actorId,
          itemId: item.id,
          decision: 'ACCEPTED_DIFFERENCE',
          note: 'Looks like the venue rounding.',
        }),
      );
      await withTenant(TENANT, () =>
        service.resolve({
          userId: actorId,
          itemId: item.id,
          decision: 'ESCALATED',
          note: 'It got bigger. Raised with the venue.',
        }),
      );

      const rows = await prisma.resolutionRecord.findMany({
        where: { itemId: item.id },
        orderBy: { decidedAt: 'asc' },
      });
      expect(rows.map((row) => row.decision)).toEqual(['ACCEPTED_DIFFERENCE', 'ESCALATED']);
    });

    /** A decision with no reason is a decision nobody can review. */
    it('refuses a resolution with no reason', async () => {
      const item = await anItem();
      await expect(
        withTenant(TENANT, () =>
          service.resolve({
            userId: actorId,
            itemId: item.id,
            decision: 'FALSE_POSITIVE',
            note: '   ',
          }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('refuses a resolution that names neither an item nor a finding', async () => {
      await expect(
        withTenant(TENANT, () =>
          service.resolve({ userId: actorId, decision: 'ESCALATED', note: 'about what?' }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    /**
     * Append-only in the database, not merely by convention. The guarantee has
     * to survive somebody writing around the API.
     */
    it('cannot be edited or deleted, even directly', async () => {
      const item = await anItem();
      const record = await withTenant(TENANT, () =>
        service.resolve({
          userId: actorId,
          itemId: item.id,
          decision: 'ESCALATED',
          note: 'Raised with the venue.',
        }),
      );

      await expect(
        prisma.resolutionRecord.update({
          where: { id: record.id },
          data: { note: 'never mind' },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.resolutionRecord.delete({ where: { id: record.id } })).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
