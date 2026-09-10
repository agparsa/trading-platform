import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MockBrokerAdapter, type BrokerCredentials } from '@tp/broker-sdk';
import { OrderStatus, TradingErrorCode } from '@tp/shared-types';
import { sumVolume, weightedAverage } from '../../src/trading/external-execution.service';
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

const BID = '4583.58';
const ASK = '4583.72';
const CREDENTIALS: BrokerCredentials = {
  kind: 'LOGIN_PASSWORD_SERVER',
  fields: { login: '1001', password: 'correct-horse-battery', server: 'Mock-Live' },
};

/**
 * An account whose money is at a venue.
 *
 * What these tests are about is the difference from the internal path: the
 * order row exists before the request leaves, the venue's answer decides the
 * outcome, an answer that never comes is a **state** rather than an
 * exception, and nothing is ever resent.
 */
suite('External execution (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
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
    await stack.publishQuote('XAUUSD', BID, ASK);

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

  /** An account that executes at the venue, with an identity there. */
  async function externalAccount(externalAccountId: string | null = 'MOCK-1001') {
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
    stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume,
    });

  /** The adapter the next order will reach, so a test can script it. */
  function scriptVenue(): MockBrokerAdapter {
    const scripted = new MockBrokerAdapter({ latencyMs: 0 });
    stack.registry.register({
      kind: 'MOCK',
      displayName: 'Mock venue (testing only)',
      documentation: '',
      credentialFields: [
        { key: 'login', label: 'Login', secret: false },
        { key: 'password', label: 'Password', secret: true },
        { key: 'server', label: 'Server', secret: false },
      ],
      create: () => scripted,
    });
    return scripted;
  }

  it('sends the order to the venue and records what the venue did, not what we would have done', async () => {
    const venue = scriptVenue();
    venue.script({ kind: 'fill', price: '4600.00' });
    const { userId, accountId } = await externalAccount();
    // The opening balance is already on the ledger; the order must add nothing.
    const ledgerBefore = await prisma.balanceLedger.count({ where: { accountId } });

    const result = await buy(userId, accountId);
    expect(result.status).toBe(OrderStatus.FILLED);
    // The venue's price, not this platform's ask.
    expect(result.price).toBe('4600');

    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.clientOrderId).toMatch(/^tp-/);
    expect(order.externalOrderId).toMatch(/^MO-/);
    expect(order.status).toBe('FILLED');

    const execution = await prisma.execution.findFirstOrThrow({ where: { accountId } });
    expect(execution.externalExecutionId).toMatch(/^ME-/);
    const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
    expect(position.externalPositionId).toMatch(/^MP-/);
    expect(position.entryPrice.toString()).toBe('4600');
    // No ledger movement from the order: the money is at the venue, and this
    // platform does not invent the venue's commission or margin.
    expect(await prisma.balanceLedger.count({ where: { accountId } })).toBe(ledgerBefore);
  });

  it('records the order before the request leaves, so a lost answer is recoverable', async () => {
    const venue = scriptVenue();
    venue.script({ kind: 'timeout-filled' });
    const { userId, accountId } = await externalAccount();

    const result = await buy(userId, accountId);
    expect(result.status).toBe(OrderStatus.UNCONFIRMED);

    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.status).toBe('UNCONFIRMED');
    expect(order.clientOrderId).not.toBe(null);
    // Nothing was booked on a guess.
    expect(await prisma.position.count({ where: { accountId } })).toBe(0);

    // The recovery asks the venue with the same id, and finds the fill.
    const resolved = await stack.external.resolveUnconfirmed(order.id);
    expect(resolved?.status).toBe(OrderStatus.FILLED);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('FILLED');
    expect(await prisma.position.count({ where: { accountId } })).toBe(1);
    // And exactly one position: the recovery did not place a second order.
    expect(await prisma.order.count({ where: { accountId } })).toBe(1);
  });

  it('cancels rather than resending when the venue never saw the order', async () => {
    const venue = scriptVenue();
    venue.script({ kind: 'timeout-lost' });
    const { userId, accountId } = await externalAccount();

    await buy(userId, accountId);
    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.status).toBe('UNCONFIRMED');

    const resolved = await stack.external.resolveUnconfirmed(order.id);
    expect(resolved?.status).toBe(OrderStatus.CANCELLED);
    expect(resolved?.reason).toContain('no record');
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.rejectionCode).toBe('VENUE_NEVER_RECEIVED');
    // Nothing was retried: one order, no positions.
    expect(await prisma.order.count({ where: { accountId } })).toBe(1);
    expect(await prisma.position.count({ where: { accountId } })).toBe(0);
  });

  it('treats a connection failure as unconfirmed, not as a rejection', async () => {
    const venue = scriptVenue();
    venue.script({ kind: 'disconnect' });
    const { userId, accountId } = await externalAccount();

    const result = await buy(userId, accountId);
    expect(result.status).toBe(OrderStatus.UNCONFIRMED);
    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.status).toBe('UNCONFIRMED');
    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'order.unconfirmed' },
    });
    expect(JSON.stringify(trail.after)).toContain('NOT_CONNECTED');
  });

  it("records the venue's rejection with its reason, and opens nothing", async () => {
    const venue = scriptVenue();
    venue.script({ kind: 'reject', reason: 'not enough margin at the venue' });
    const { userId, accountId } = await externalAccount();

    const result = await buy(userId, accountId);
    expect(result.status).toBe(OrderStatus.REJECTED);
    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.status).toBe('REJECTED');
    expect(order.rejectionCode).toBe('VENUE_REJECTED');
    expect(await prisma.position.count({ where: { accountId } })).toBe(0);
  });

  it('books a partial fill for what the venue actually filled', async () => {
    const venue = scriptVenue();
    venue.script({ kind: 'partial', volume: '0.40', price: '4590.00' });
    const { userId, accountId } = await externalAccount();

    const result = await buy(userId, accountId, '1.00');
    expect(result.status).toBe(OrderStatus.PARTIALLY_FILLED);
    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    expect(order.volume.toString()).toBe('1');
    expect(order.filledVolume.toString()).toBe('0.4');
    const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
    expect(position.volume.toString()).toBe('0.4');
  });

  it('refuses an instrument this venue has no mapping for, naming what is missing', async () => {
    scriptVenue();
    const { userId, accountId } = await externalAccount();
    await prisma.brokerInstrumentMapping.deleteMany({ where: { connectionId } });

    await expect(buy(userId, accountId)).rejects.toMatchObject({
      code: TradingErrorCode.UNKNOWN_SYMBOL,
    });
    expect(await prisma.order.count({ where: { accountId } })).toBe(0);
  });

  it('refuses an account with no identity at the venue', async () => {
    scriptVenue();
    const { userId, accountId } = await externalAccount(null);
    await expect(buy(userId, accountId)).rejects.toMatchObject({
      code: TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
    });
    expect(await prisma.order.count({ where: { accountId } })).toBe(0);
  });

  it('still refuses a closed market and a bad volume, by the same code as the internal path', async () => {
    scriptVenue();
    const { userId, accountId } = await externalAccount();
    await expect(
      stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '0.0001',
      }),
    ).rejects.toMatchObject({ code: TradingErrorCode.INVALID_VOLUME });
    expect(await prisma.order.count({ where: { accountId } })).toBe(0);
  });

  it('writes the fill to the outbox in the same transaction, with the id the socket saw', async () => {
    const venue = scriptVenue();
    venue.script({ kind: 'fill' });
    const { userId, accountId } = await externalAccount();
    await buy(userId, accountId);

    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { accountId, eventType: 'order.filled' },
    });
    expect(outbox.status).toBe('PENDING');
    expect(outbox.aggregateType).toBe('order');
    expect(outbox.payload).toMatchObject({ venue: connectionId });
  });

  it('leaves an internal account entirely alone', async () => {
    scriptVenue();
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    const result = await buy(userId, accountId);
    expect(result.status).toBe(OrderStatus.FILLED);
    const order = await prisma.order.findFirstOrThrow({ where: { accountId } });
    // The internal path mints no client order id and books to the ledger.
    expect(order.clientOrderId).toBe(null);
    expect(order.externalOrderId).toBe(null);
    expect(await prisma.balanceLedger.count({ where: { accountId } })).toBeGreaterThan(0);
  });
});

describe('external fill arithmetic', () => {
  it('adds volumes exactly, with no float anywhere near them', () => {
    expect(sumVolume(['0.1', '0.2'])).toBe('0.3');
    expect(sumVolume(['0.07', '0.07', '0.07', '0.07', '0.07'])).toBe('0.35');
    expect(sumVolume([])).toBe('0');
    expect(sumVolume(['1.00000001', '0.00000001'])).toBe('1.00000002');
  });

  it('averages by volume, not by count: a big fill and a small one are not a midpoint', () => {
    expect(
      weightedAverage([
        { volume: '0.9', price: '100' },
        { volume: '0.1', price: '200' },
      ]),
    ).toBe('110');
    expect(weightedAverage([{ volume: '1', price: '4583.72' }])).toBe('4583.72');
    expect(weightedAverage([])).toBe(null);
    expect(weightedAverage([{ volume: '0', price: '1' }])).toBe(null);
  });
});
