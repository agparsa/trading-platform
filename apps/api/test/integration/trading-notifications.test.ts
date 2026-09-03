import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { CloseReason, DomainEvent } from '@tp/shared-types';
import { requireTenantId, withoutTenantScope } from '@tp/tenancy';
import {
  EventsService,
  INSTANCE_ID,
  type DomainEventEnvelope,
} from '../../src/realtime/events.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { TradingNotificationsService } from '../../src/notifications/trading-notifications.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  DEFAULT_TENANT_ID,
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedSymbols,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

interface RaisedJob {
  userId: string;
  kind: string;
  dedupeKey: string | null;
  accountId: string | null;
  data: Record<string, unknown>;
  tenantId: string;
}

/** Captures what would have been queued, and the tenant it was queued in. */
class CapturingNotifications extends NotificationsService {
  readonly raised: RaisedJob[] = [];

  constructor(private readonly tenantOf: () => string) {
    super(null as never, null as never);
  }

  override async raise(job: Parameters<NotificationsService['raise']>[0]): Promise<void> {
    this.raised.push({
      userId: job.userId,
      kind: job.kind,
      dedupeKey: job.dedupeKey ?? null,
      accountId: job.accountId ?? null,
      data: job.data ?? {},
      // Read through the same call the real service makes, so a handler that
      // failed to enter the tenant scope throws here rather than passing.
      tenantId: this.tenantOf(),
    });
  }
}

/**
 * Trading events becoming notifications.
 *
 * The two properties that matter are not about wording. One: a handler on an
 * instance that did not publish the event has no request behind it, so it must
 * enter the tenant scope from the envelope or every database read fails. Two:
 * both instances raise the same notice, and only the shared `eventId` as
 * `dedupeKey` stops the trader hearing it twice.
 */
suite('Trading events become notifications (integration)', () => {
  let prisma: PrismaClient;
  let events: EventsService;
  let captured: CapturingNotifications;
  let accountId: string;
  let userId: string;

  const redisStub = {
    publisher: { publish: async () => 1 },
  } as never;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedSymbols(prisma);

    // createAccount makes its own user; it is the only path that also allocates
    // an account number from the sequence.
    const created = await createAccount(prisma);
    userId = created.userId;
    accountId = created.accountId;

    events = new EventsService(redisStub);
    // `requireTenantId` throws when no scope is active, so reading it here is
    // the assertion: a handler that failed to enter the envelope's tenant
    // scope fails the test rather than quietly writing to the wrong one.
    captured = new CapturingNotifications(() => requireTenantId());
    const trading = new TradingNotificationsService(
      events,
      prisma as unknown as PrismaService,
      captured,
    );
    trading.onModuleInit();
  });

  it('raises one notice when a position opens', async () => {
    await events.publish(DomainEvent.POSITION_OPENED, accountId, {
      symbol: 'BTCUSDT',
      side: 'BUY',
      volume: '0.10',
      entryPrice: '64120.50',
    });

    expect(captured.raised).toHaveLength(1);
    expect(captured.raised[0]?.kind).toBe('position.opened');
    expect(captured.raised[0]?.userId).toBe(userId);
    expect(captured.raised[0]?.accountId).toBe(accountId);
  });

  it('uses the event id as the dedupe key', async () => {
    await events.publish(DomainEvent.POSITION_OPENED, accountId, { symbol: 'BTCUSDT' });

    const raised = captured.raised[0];
    // Generated once at publication and carried on the envelope, so the same
    // event handled on a second instance produces the same key and the second
    // job is a no-op at the database.
    expect(raised?.dedupeKey).toBe(raised?.data['eventId']);
    expect(typeof raised?.dedupeKey).toBe('string');
  });

  it('handles an event from another instance with no request behind it', async () => {
    const fromElsewhere: DomainEventEnvelope = {
      event: DomainEvent.POSITION_CLOSED,
      eventId: 'evt-from-elsewhere',
      origin: 'a-different-process',
      accountId,
      tenantId: DEFAULT_TENANT_ID,
      data: { symbol: 'BTCUSDT', reason: CloseReason.TAKE_PROFIT, netPnl: '42', fullyClosed: true },
      timestamp: Date.now(),
      version: 2,
      aggregateType: 'account',
      aggregateId: accountId,
      actorId: null,
      correlationId: null,
      causationId: null,
    };

    /**
     * Deliberately outside every tenant scope.
     *
     * This is what a Redis subscriber actually looks like: no request, no
     * middleware, no ambient tenant. A handler that relies on an inherited
     * scope passes on the publishing instance and throws on every other one.
     */
    await withoutTenantScope('simulating a Redis subscriber', async () => {
      await events.deliverRemote(fromElsewhere);
    });

    expect(captured.raised).toHaveLength(1);
    expect(captured.raised[0]?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(captured.raised[0]?.dedupeKey).toBe('evt-from-elsewhere');
  });

  it('gives both instances the same dedupe key for one event', async () => {
    await events.publish(DomainEvent.POSITION_OPENED, accountId, { symbol: 'BTCUSDT' });
    const published = captured.raised[0];

    // The envelope the other instance would receive over Redis.
    await withoutTenantScope('simulating a Redis subscriber', async () => {
      await events.deliverRemote({
        event: DomainEvent.POSITION_OPENED,
        eventId: published!.data['eventId'] as string,
        origin: 'a-different-process',
        accountId,
        tenantId: DEFAULT_TENANT_ID,
        data: { symbol: 'BTCUSDT' },
        timestamp: Date.now(),
        version: 2,
        aggregateType: 'account',
        aggregateId: accountId,
        actorId: null,
        correlationId: null,
        causationId: null,
      });
    });

    expect(captured.raised).toHaveLength(2);
    // Two jobs, one key: the worker writes one row and pushes once.
    expect(captured.raised[0]?.dedupeKey).toBe(captured.raised[1]?.dedupeKey);
  });

  it("refuses this instance's own echo", async () => {
    await events.publish(DomainEvent.POSITION_OPENED, accountId, { symbol: 'BTCUSDT' });
    const first = captured.raised.length;

    await events.deliverRemote({
      event: DomainEvent.POSITION_OPENED,
      eventId: 'evt-echo',
      origin: INSTANCE_ID,
      accountId,
      tenantId: DEFAULT_TENANT_ID,
      data: { symbol: 'BTCUSDT' },
      timestamp: Date.now(),
      version: 2,
      aggregateType: 'account',
      aggregateId: accountId,
      actorId: null,
      correlationId: null,
      causationId: null,
    });

    expect(captured.raised).toHaveLength(first);
  });

  it('raises nothing for an account it cannot find', async () => {
    await events.publish(DomainEvent.POSITION_OPENED, '00000000-0000-4000-8000-00000000dead', {
      symbol: 'BTCUSDT',
    });
    expect(captured.raised).toEqual([]);
  });

  it('raises nothing for an event with no tenant', async () => {
    await withoutTenantScope('a publisher that lost its scope', async () => {
      await events.deliverRemote({
        event: DomainEvent.POSITION_OPENED,
        eventId: 'evt-no-tenant',
        origin: 'a-different-process',
        accountId,
        tenantId: null,
        data: { symbol: 'BTCUSDT' },
        timestamp: Date.now(),
        version: 2,
        aggregateType: 'account',
        aggregateId: accountId,
        actorId: null,
        correlationId: null,
        causationId: null,
      });
    });
    // Filing it under a default tenant would put one firm's trade in another
    // firm's notification list. Dropping it and shouting is the safe direction.
    expect(captured.raised).toEqual([]);
  });

  it('does not raise twice for one fill', async () => {
    // Orders publish ORDER_FILLED and POSITION_OPENED together for one action.
    await events.publish(DomainEvent.ORDER_FILLED, accountId, {
      symbol: 'BTCUSDT',
      orderId: 'o-1',
      positionId: 'p-1',
    });
    await events.publish(DomainEvent.POSITION_OPENED, accountId, {
      symbol: 'BTCUSDT',
      positionId: 'p-1',
    });

    expect(captured.raised).toHaveLength(1);
    expect(captured.raised[0]?.kind).toBe('position.opened');
  });
});
