import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainEvent, TradingErrorCode } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { runInRequestScope } from '../../src/common/request-scope';
import { OutboxService } from '../../src/outbox/outbox.service';
import {
  DEFAULT_TENANT_ID,
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
 * The outbox exists for one window: the moment between a fill committing and
 * anyone being told about it.
 *
 * Publish inside the transaction and a rollback erases a fill a subscriber
 * has already been told about. Publish after it and a crash in between loses
 * the announcement entirely. So the row is written **with** the change, and
 * these tests are about that word: it commits with the fill, it disappears
 * with a rollback, and it carries the same event id the socket frame carries
 * so one occurrence is never counted twice.
 */
suite('Outbox (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let outbox: OutboxService;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');
    outbox = new OutboxService();
  });

  it('a fill and its outbox rows commit together, carrying the ids the socket carries', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const result = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });

    const rows = await prisma.outboxEvent.findMany({
      where: { accountId },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows.map((row) => row.eventType)).toEqual([
      DomainEvent.ORDER_FILLED,
      DomainEvent.POSITION_OPENED,
    ]);
    expect(rows.every((row) => row.status === 'PENDING' && row.attempts === 0)).toBe(true);
    // The event names what it is about, so a subscriber can route on it
    // without parsing the payload.
    expect(rows[0]).toMatchObject({ aggregateType: 'order', aggregateId: result.orderId });
    expect(rows[1]).toMatchObject({ aggregateType: 'position', aggregateId: result.positionId });
    expect(rows[0]?.payload).toMatchObject({ orderId: result.orderId, price: '4583.72' });
    // One occurrence, one id: the ids are distinct from each other and stable.
    expect(new Set(rows.map((row) => row.eventId)).size).toBe(2);
  });

  it('nothing is announced about a fill that did not happen', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '10' });
    // Not enough margin: the transaction rolls back, and the outbox row that
    // was written inside it goes with it.
    await expect(
      stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '5.00',
      }),
    ).rejects.toMatchObject({ code: TradingErrorCode.INSUFFICIENT_MARGIN });

    expect(await prisma.outboxEvent.count({ where: { accountId } })).toBe(0);
    expect(await prisma.position.count({ where: { accountId } })).toBe(0);
  });

  /**
   * The guarantee this whole file exists for, proved the only way it can be:
   * by making the announcement fail and checking the fill went with it.
   *
   * A trigger that refuses the outbox insert stands in for anything that can
   * go wrong at that moment. If the row were written after the fill's
   * transaction rather than inside it, the fill would be committed and only
   * the announcement lost — a position on the books nobody was told about.
   */
  it('a fill that could not be recorded in the outbox is not a fill at all', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION test_refuse_outbox() RETURNS trigger AS $$ ` +
        `BEGIN RAISE EXCEPTION 'the outbox is unavailable'; END; $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_refuse_outbox BEFORE INSERT ON outbox_events ` +
        `FOR EACH ROW EXECUTE FUNCTION test_refuse_outbox()`,
    );
    try {
      await expect(
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.10',
        }),
      ).rejects.toThrow();

      // Nothing happened: no order, no position, no execution, no ledger
      // movement beyond the opening balance.
      expect(await prisma.order.count({ where: { accountId } })).toBe(0);
      expect(await prisma.position.count({ where: { accountId } })).toBe(0);
      expect(await prisma.execution.count({ where: { accountId } })).toBe(0);
      expect(await prisma.outboxEvent.count({ where: { accountId } })).toBe(0);
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toString()).toBe('100000');
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER test_refuse_outbox ON outbox_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION test_refuse_outbox()`);
    }
  });

  it('a row rolled back with its transaction leaves nothing behind', async () => {
    const { accountId } = await createAccount(prisma, { balance: '1000' });
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.record(
          tx as unknown as Parameters<OutboxService['record']>[0],
          DomainEvent.ORDER_FILLED,
          accountId,
          { orderId: 'never-committed' },
        );
        throw new Error('the change this event described failed');
      }),
    ).rejects.toThrow('the change this event described failed');
    expect(await prisma.outboxEvent.count({ where: { accountId } })).toBe(0);
  });

  it('carries who did it and which request it belonged to, so an event can be traced back', async () => {
    const { accountId } = await createAccount(prisma, { balance: '1000' });
    const actorId = (
      await prisma.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email: 'trace@test.local',
          passwordHash: 'not-a-real-hash',
          displayName: 'Trace',
          role: 'ADMIN',
        },
      })
    ).id;

    const recorded = await runInRequestScope({ requestId: 'req-42', actorId }, () =>
      prisma.$transaction((tx) =>
        outbox.record(
          tx as unknown as Parameters<OutboxService['record']>[0],
          DomainEvent.ORDER_FILLED,
          accountId,
          { orderId: 'o-1' },
        ),
      ),
    );

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventId: recorded.eventId },
    });
    expect(row).toMatchObject({ actorId, correlationId: 'req-42' });
  });

  it('files the event under the firm it happened in, and no other firm can read it', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });
    const rows = await prisma.outboxEvent.findMany({ where: { accountId } });
    expect(rows.every((row) => row.tenantId === DEFAULT_TENANT_ID)).toBe(true);

    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      expect(await prisma.outboxEvent.findMany({ where: { accountId } })).toEqual([]);
    });
  });

  it('is a record, not a draft: its content cannot be rewritten', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { accountId } });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE outbox_events SET payload = '{"price":"1.00"}'::jsonb WHERE id = $1`,
        row.id,
      ),
    ).rejects.toThrow();
    // Delivery bookkeeping is not content, and must still be writable.
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { status: 'RELAYED', relayedAt: new Date(), attempts: 1 },
    });
    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('RELAYED');
    expect(after.payload).toMatchObject({ price: '4583.72' });
  });
});
