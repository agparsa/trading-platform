import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  BrokerAdapterRegistry,
  MockBrokerAdapter,
  mockBrokerAdapterFactory,
  type BrokerCredentials,
  type BrokerInstrument,
} from '@tp/broker-sdk';
import { SecretBox, generateEncryptionKey, parseEncryptionKeys } from '@tp/crypto-core';
import { TradingErrorCode } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { BrokerConnectionsService } from '../../src/broker-connections/broker-connections.service';
import { BrokerMappingService } from '../../src/broker-connections/broker-mapping.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { SecretBoxService } from '../../src/common/crypto/crypto.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  DEFAULT_TENANT_ID,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

const CREDENTIALS: BrokerCredentials = {
  kind: 'LOGIN_PASSWORD_SERVER',
  fields: { login: '1001', password: 'correct-horse-battery', server: 'Mock-Live' },
};

/**
 * A mapping is the sentence "on this venue, our XAUUSD is called XAUUSD.m".
 *
 * What these tests are about is that the sentence is always written by a
 * person and never inferred: an unmapped instrument is refused by name, a
 * venue symbol the venue does not list cannot be mapped at all, and a
 * suggestion stays a suggestion until someone confirms it. The venue's own
 * lot terms are copied beside the mapping so a drift shows up as a reported
 * difference rather than as a run of rejections nobody can explain.
 */
suite('Broker instrument mappings (integration)', () => {
  let prisma: PrismaClient;
  let connections: BrokerConnectionsService;
  let mappings: BrokerMappingService;
  let registry: BrokerAdapterRegistry;
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

    const prismaService = prisma as unknown as PrismaService;
    const secrets = new SecretBox(
      parseEncryptionKeys(generateEncryptionKey('test')),
    ) as unknown as SecretBoxService;
    registry = new BrokerAdapterRegistry();
    const audit = new AuditService(prismaService);
    connections = new BrokerConnectionsService(prismaService, audit, secrets, registry);
    mappings = new BrokerMappingService(prismaService, audit, connections);

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
    const connection = await connections.create(actorId, {
      name: 'Mock venue',
      adapterKind: 'MOCK',
    });
    connectionId = connection.id;
    await connections.setCredentials(actorId, connectionId, CREDENTIALS);
  });

  /** Replace the registry's MOCK with an adapter whose catalogue a test controls. */
  function venueListing(instruments: readonly BrokerInstrument[]): MockBrokerAdapter {
    const adapter = new MockBrokerAdapter({ latencyMs: 0, instruments });
    registry.register({ ...mockBrokerAdapterFactory, create: () => adapter });
    return adapter;
  }

  it('reads the venue catalogue live and marks what is already mapped', async () => {
    const before = await mappings.catalogue(connectionId);
    expect(before.map((row) => row.externalSymbol)).toEqual(['XAUUSD.m', 'EURUSD.m']);
    expect(before.every((row) => row.mappedTo === null)).toBe(true);

    await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
    });
    const after = await mappings.catalogue(connectionId);
    expect(after.find((row) => row.externalSymbol === 'XAUUSD.m')?.mappedTo).toBe('XAUUSD');
    expect(after.find((row) => row.externalSymbol === 'EURUSD.m')?.mappedTo).toBe(null);
  });

  it("copies the venue's own terms onto the mapping, and audits who mapped it", async () => {
    const mapping = await mappings.map(actorId, connectionId, {
      symbolCode: 'xauusd',
      externalSymbol: 'XAUUSD.m',
    });
    expect(mapping).toMatchObject({
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
      contractSize: '100',
      volumeStep: '0.01',
      minVolume: '0.01',
      maxVolume: '50',
      priceDecimals: 2,
      enabled: true,
    });
    expect(mapping.syncedAt).not.toBe(null);

    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'broker_mapping.set' },
    });
    expect(trail.actorId).toBe(actorId);
    expect(trail.after).toMatchObject({ symbol: 'XAUUSD', externalSymbol: 'XAUUSD.m' });
  });

  it('refuses to map a symbol this platform does not trade, or one the venue does not list', async () => {
    await expect(
      mappings.map(actorId, connectionId, { symbolCode: 'NOPE', externalSymbol: 'XAUUSD.m' }),
    ).rejects.toMatchObject({ code: TradingErrorCode.UNKNOWN_SYMBOL });
    await expect(
      mappings.map(actorId, connectionId, { symbolCode: 'XAUUSD', externalSymbol: 'GOLD' }),
    ).rejects.toMatchObject({ code: TradingErrorCode.UNKNOWN_SYMBOL });
    expect(await prisma.brokerInstrumentMapping.count()).toBe(0);
  });

  it('refuses to trade an unmapped instrument by name, rather than guessing the venue calls it what we do', async () => {
    await expect(mappings.requireExternalSymbol(connectionId, 'XAUUSD')).rejects.toMatchObject({
      code: TradingErrorCode.UNKNOWN_SYMBOL,
      // The refusal has to say what to do about it.
      message: expect.stringContaining('not mapped'),
    });

    await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
    });
    expect(await mappings.requireExternalSymbol(connectionId, 'XAUUSD')).toBe('XAUUSD.m');

    await mappings.setEnabled(actorId, connectionId, 'XAUUSD', false);
    await expect(mappings.requireExternalSymbol(connectionId, 'XAUUSD')).rejects.toMatchObject({
      code: TradingErrorCode.UNKNOWN_SYMBOL,
      message: expect.stringContaining('turned off'),
    });
  });

  it('suggests by normalised name without mapping anything, and stays quiet where a name is ambiguous', async () => {
    venueListing([
      instrument('XAU/USD'),
      // A second gold contract normalising the same way: exactly the case a
      // person must resolve, so it must not be silently preferred.
      instrument('XAUUSD'),
      instrument('EURUSD.m'),
    ]);
    const suggestions = await mappings.suggest(connectionId);
    expect(suggestions).toContainEqual({ symbolCode: 'XAUUSD', externalSymbol: 'XAU/USD' });
    expect(suggestions.filter((row) => row.symbolCode === 'XAUUSD')).toHaveLength(1);
    // Suggesting is not mapping.
    expect(await prisma.brokerInstrumentMapping.count()).toBe(0);
    await expect(mappings.requireExternalSymbol(connectionId, 'XAUUSD')).rejects.toMatchObject({
      code: TradingErrorCode.UNKNOWN_SYMBOL,
    });
  });

  it('does not suggest an external symbol that is already mapped', async () => {
    await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
    });
    const suggestions = await mappings.suggest(connectionId);
    expect(suggestions.map((row) => row.externalSymbol)).not.toContain('XAUUSD.m');
  });

  it('reports a lot step that moved on the venue rather than swallowing it', async () => {
    await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
    });
    venueListing([instrument('XAUUSD.m', { volumeStep: '0.10', maxVolume: '20' })]);

    const report = await mappings.sync(actorId, connectionId);
    expect(report.checked).toBe(1);
    expect(report.changed).toEqual([
      {
        symbolCode: 'XAUUSD',
        differences: ['volumeStep: 0.01 → 0.10', 'maxVolume: 50 → 20'],
      },
    ]);
    expect(report.missing).toEqual([]);
    // The new terms are stored, so the next order is checked against them.
    const [stored] = await mappings.list(connectionId);
    expect(stored?.volumeStep).toBe('0.1');
    await prisma.auditLog.findFirstOrThrow({ where: { action: 'broker_mapping.synced' } });
  });

  it('reports a mapped instrument the venue has stopped listing, and repairs nothing', async () => {
    await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
    });
    venueListing([instrument('EURUSD.m')]);

    const report = await mappings.sync(actorId, connectionId);
    expect(report.missing).toEqual(['XAUUSD']);
    // Still mapped, still pointing where it pointed: what a vanished
    // instrument means is a person's decision, not a sweep's.
    const [stored] = await mappings.list(connectionId);
    expect(stored?.externalSymbol).toBe('XAUUSD.m');
    expect(await prisma.brokerInstrumentMapping.count()).toBe(1);
  });

  it('re-mapping an instrument moves it and keeps what it used to be in the trail', async () => {
    await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
    });
    venueListing([instrument('XAUUSD.m'), instrument('GOLD')]);
    const moved = await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'GOLD',
    });
    expect(moved.externalSymbol).toBe('GOLD');
    // One mapping per (connection, symbol): the move is an update, not a second row.
    expect(await prisma.brokerInstrumentMapping.count()).toBe(1);
    const trail = await prisma.auditLog.findMany({
      where: { action: 'broker_mapping.set' },
      orderBy: { createdAt: 'asc' },
    });
    expect(trail[1]?.before).toMatchObject({ externalSymbol: 'XAUUSD.m' });
  });

  it('will not read another firm’s mapping', async () => {
    await mappings.map(actorId, connectionId, {
      symbolCode: 'XAUUSD',
      externalSymbol: 'XAUUSD.m',
    });
    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      expect(await mappings.list(connectionId)).toEqual([]);
      await expect(mappings.requireExternalSymbol(connectionId, 'XAUUSD')).rejects.toMatchObject({
        code: TradingErrorCode.UNKNOWN_SYMBOL,
      });
    });
  });
});

function instrument(
  externalSymbol: string,
  overrides: Partial<BrokerInstrument> = {},
): BrokerInstrument {
  return {
    externalSymbol,
    description: externalSymbol,
    quoteCurrency: 'USD',
    contractSize: '100',
    volumeStep: '0.01',
    minVolume: '0.01',
    maxVolume: '50',
    priceDecimals: 2,
    tradable: true,
    ...overrides,
  };
}
