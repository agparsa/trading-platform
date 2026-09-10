import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  BrokerAdapterError,
  BrokerErrorCode,
  MockBrokerAdapter,
  type BrokerAdapter,
  type BrokerCredentials,
} from '@tp/broker-sdk';
import { OrderStatus } from '@tp/shared-types';
import { BrokerInboxService } from '../../src/broker-connections/broker-inbox.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

const CREDENTIALS: BrokerCredentials = {
  kind: 'LOGIN_PASSWORD_SERVER',
  fields: { login: '1001', password: 'correct-horse-battery', server: 'Mock-Live' },
};

/**
 * The sequence after a connection dies mid-order (§43).
 *
 * The platform is left holding an order it cannot describe: sent, and
 * unanswered. Recovery is a fixed sequence — reconnect, ask about every
 * unanswered order by the id we sent, record whatever the venue says, and
 * take the redelivered event window without double-counting anything in it.
 *
 * These tests are about the two things that must never happen in that
 * sequence: an order resent (one intent, two positions), and an unreachable
 * venue read as an answer.
 */
suite('Venue recovery after a lost connection (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let inbox: BrokerInboxService;
  let actorId: string;
  let connectionId: string;

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
    inbox = new BrokerInboxService(prisma as unknown as PrismaService);

    actorId = (
      await prisma.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email: 'ops@test.local',
          passwordHash: 'not-a-real-hash',
          displayName: 'Ops',
          role: 'ADMIN',
        },
      })
    ).id;
    /**
     * A venue-routed account only executes when the platform has switched
     * external execution on for the firm (§95). These tests are about the
     * venue, so the flag is on; `features.test.ts` is where it is off.
     */
    await prisma.tenantFeature.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        key: 'external_execution',
        enabled: true,
        authority: 'PLATFORM',
        note: 'test venue',
        updatedByUserId: actorId,
      },
    });
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

  const FACTORY = {
    kind: 'MOCK',
    displayName: 'Mock venue (testing only)',
    documentation: '',
    credentialFields: [
      { key: 'login', label: 'Login', secret: false },
      { key: 'password', label: 'Password', secret: true },
      { key: 'server', label: 'Server', secret: false },
    ],
  };

  /**
   * One adapter for the whole test, so the venue's state survives the
   * platform building and disposing a session around each call.
   */
  function venue(
    accounts?: readonly { id: string; currency: string; balance: string }[],
  ): MockBrokerAdapter {
    const adapter = new MockBrokerAdapter({
      latencyMs: 0,
      ...(accounts === undefined ? {} : { accounts }),
    });
    stack.registry.register({ ...FACTORY, create: () => adapter });
    return adapter;
  }

  /** The venue cannot be reached at all: the session will not open. */
  function unreachable(): void {
    stack.registry.register({
      ...FACTORY,
      create: () =>
        ({
          kind: 'MOCK',
          connect: () =>
            Promise.reject(
              new BrokerAdapterError(BrokerErrorCode.NOT_CONNECTED, 'the venue is down', true),
            ),
          disconnect: () => Promise.resolve(),
        }) as unknown as BrokerAdapter,
    });
  }

  async function externalAccount(externalAccountId = 'MOCK-1001') {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    await prisma.account.update({
      where: { id: accountId },
      data: {
        executionMode: 'EXTERNAL_BROKER',
        brokerConnectionId: connectionId,
        externalAccountId,
      },
    });
    return { userId, accountId };
  }

  const buy = (userId: string, accountId: string, volume = '1.00') =>
    stack.orders.openPosition(userId, { accountId, symbol: 'XAUUSD', side: 'BUY', volume });

  it('the whole sequence: lost answer, reconnect, ask, and exactly one position', async () => {
    const adapter = venue();
    // The venue fills it and the answer never arrives.
    adapter.script({ kind: 'timeout-filled' });
    const { userId, accountId } = await externalAccount();

    const placed = await buy(userId, accountId);
    expect(placed.status).toBe(OrderStatus.UNCONFIRMED);
    expect(await prisma.position.count({ where: { accountId } })).toBe(0);

    // The sweep asks with the id that was sent. It never places anything.
    const summary = await stack.recovery.run();
    expect(summary).toEqual({ examined: 1, resolved: 1, unresolved: 0 });

    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.status).toBe('FILLED');
    expect(order.externalOrderId).toMatch(/^MO-/);
    // One order, one position, one execution — the venue's fill, found, not repeated.
    expect(await prisma.order.count({ where: { accountId } })).toBe(1);
    expect(await prisma.position.count({ where: { accountId } })).toBe(1);
    expect(await prisma.execution.count({ where: { accountId } })).toBe(1);
    // And the venue itself agrees it holds exactly one. (The platform builds
    // and disposes a session per call, so the test opens its own to look.)
    await adapter.connect(CREDENTIALS);
    expect(await adapter.getPositions('MOCK-1001')).toHaveLength(1);

    // A second pass has nothing left to do.
    expect(await stack.recovery.run()).toEqual({ examined: 0, resolved: 0, unresolved: 0 });
  });

  it('an unreachable venue leaves the order unconfirmed, and is not an answer about it', async () => {
    const adapter = venue();
    adapter.script({ kind: 'timeout-filled' });
    const { userId, accountId } = await externalAccount();
    await buy(userId, accountId);

    // The venue is unreachable when the sweep runs.
    unreachable();
    const first = await stack.recovery.run();
    expect(first).toEqual({ examined: 1, resolved: 0, unresolved: 1 });
    const still = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(still.status).toBe('UNCONFIRMED');
    // Not cancelled, not rejected, not filled on a guess: nothing was decided.
    expect(still.rejectionCode).toBe(null);
    expect(await prisma.position.count({ where: { accountId } })).toBe(0);

    // When the venue comes back the same question gets a real answer.
    stack.registry.register({ ...FACTORY, create: () => adapter });
    expect(await stack.recovery.run()).toEqual({ examined: 1, resolved: 1, unresolved: 0 });
    expect((await prisma.order.findFirstOrThrow({ where: { accountId } })).status).toBe('FILLED');
    expect(await prisma.position.count({ where: { accountId } })).toBe(1);
  });

  it('an order the venue never received is cancelled, never re-placed', async () => {
    const adapter = venue();
    adapter.script({ kind: 'timeout-lost' });
    const { userId, accountId } = await externalAccount();
    await buy(userId, accountId);

    expect(await stack.recovery.run()).toEqual({ examined: 1, resolved: 1, unresolved: 0 });
    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.status).toBe('CANCELLED');
    expect(order.rejectionCode).toBe('VENUE_NEVER_RECEIVED');
    // The decision to try again at today's price belongs to the trader.
    expect(await prisma.order.count({ where: { accountId } })).toBe(1);
    await adapter.connect(CREDENTIALS);
    expect(await adapter.getPositions('MOCK-1001')).toHaveLength(0);

    await prisma.auditLog.findFirstOrThrow({
      where: { action: 'order.unconfirmed_resolved' },
    });
  });

  it('leaves an order alone until the answer has really had time to arrive', async () => {
    const adapter = venue();
    adapter.script({ kind: 'timeout-filled' });
    const { userId, accountId } = await externalAccount();
    await buy(userId, accountId);

    // A pass whose grace window has not yet passed for this order examines nothing:
    // the original request may still be in flight at the venue.
    const tooSoon = await stack.recovery.run(new Date(Date.now() - 60_000));
    expect(tooSoon).toEqual({ examined: 0, resolved: 0, unresolved: 0 });
    expect((await prisma.order.findFirstOrThrow({ where: { accountId } })).status).toBe(
      'UNCONFIRMED',
    );
  });

  it('takes the redelivered event window after a reconnect without double-counting it', async () => {
    const adapter = venue();
    const { userId, accountId } = await externalAccount();

    const seen: Parameters<Parameters<MockBrokerAdapter['onEvent']>[0]>[0][] = [];
    adapter.onEvent((event) => seen.push(event));
    await buy(userId, accountId);
    expect(seen.length).toBeGreaterThan(0);

    // Everything the venue pushed, recorded once.
    // The window as the venue first sent it, before the reconnect adds its own
    // connection events to what this handler has seen.
    const window = [...seen];
    const first = await inbox.recordAll(connectionId, window);
    expect(first.recorded).toBe(window.length);
    expect(first.duplicates).toBe(0);

    /**
     * A venue that lost the connection replays its window on reconnect, and
     * commonly in a different order than it first sent. Neither the repeat nor
     * the disorder may become a second fill.
     */
    adapter.dropConnection();
    await adapter.connect(CREDENTIALS);
    const replayed = await inbox.recordAll(connectionId, [...window].reverse());
    expect(replayed).toEqual({ recorded: 0, duplicates: window.length });
    expect(await prisma.brokerInboundEvent.count({ where: { connectionId } })).toBe(window.length);

    // And the trading rows are untouched by the replay.
    expect(await prisma.position.count({ where: { accountId } })).toBe(1);
    expect(await prisma.execution.count({ where: { accountId } })).toBe(1);
  });

  it('resolves every waiting order in one pass, not just the first', async () => {
    const adapter = venue([
      { id: 'MOCK-1001', currency: 'USD', balance: '100000' },
      { id: 'MOCK-1002', currency: 'USD', balance: '100000' },
    ]);
    adapter.script({ kind: 'timeout-filled' }, { kind: 'timeout-filled' });
    const first = await externalAccount('MOCK-1001');
    const second = await externalAccount('MOCK-1002');
    await buy(first.userId, first.accountId);
    await buy(second.userId, second.accountId);

    const summary = await stack.recovery.run();
    expect(summary).toEqual({ examined: 2, resolved: 2, unresolved: 0 });
    expect(await prisma.order.count({ where: { status: 'UNCONFIRMED' } })).toBe(0);
    expect(await prisma.position.count()).toBe(2);
  });
});
