import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Feature, FEATURES, TradingErrorCode, type DomainError } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { FeaturesService } from '../../src/features/features.service';
import { AuditService } from '../../src/common/audit/audit.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SLUG,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;
const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG, kind: 'BROKER' as const };

/**
 * Feature flags (§95).
 *
 * The catalogue decides who may write each flag and what the default is; the
 * service enforces both, and the trading and webhook paths refuse when a
 * server-enforced flag is off. What is pinned: defaults hold with no rows; a
 * firm cannot flip a platform flag and the platform does not set a firm's; one
 * firm's flags never reach another; and the enforcement points actually refuse.
 */
suite('features', () => {
  let prisma: PrismaClient;
  let service: FeaturesService;
  let admin: string;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    service = new FeaturesService(
      prisma as unknown as PrismaService,
      new AuditService(prisma as unknown as PrismaService),
    );
    admin = (await createAccount(prisma, { balance: '0' })).userId;
  });

  const failure = async (promise: Promise<unknown>): Promise<DomainError> => {
    try {
      await promise;
    } catch (error) {
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  };

  it('answers every flag with its catalogue default when nothing is set', async () => {
    const effective = await withTenant(TENANT, () => service.effective());
    for (const definition of FEATURES) {
      expect(effective[definition.key]).toBe(definition.default);
    }
    const listed = await withTenant(TENANT, () => service.list());
    expect(listed.every((row) => row.override === null)).toBe(true);
  });

  it('lets a firm set its own flag, and reads it back within the cache window', async () => {
    await withTenant(TENANT, () =>
      service.set({
        actorId: admin,
        actorAuthority: 'FIRM',
        key: Feature.TRAILING_STOP,
        enabled: false,
        note: 'The desk asked for stops to be explicit',
      }),
    );
    expect(await withTenant(TENANT, () => service.isEnabled(Feature.TRAILING_STOP))).toBe(false);
    const state = (await withTenant(TENANT, () => service.list())).find(
      (row) => row.key === Feature.TRAILING_STOP,
    );
    expect(state?.override?.note).toMatch(/explicit/);
  });

  it('refuses a firm flipping a platform flag, and the platform setting a firm’s', async () => {
    const firm = await failure(
      withTenant(TENANT, () =>
        service.set({
          actorId: admin,
          actorAuthority: 'FIRM',
          key: Feature.EXTERNAL_EXECUTION,
          enabled: true,
          note: 'we would like this',
        }),
      ),
    );
    expect(firm.code).toBe(TradingErrorCode.FORBIDDEN);
    expect(firm.message).toMatch(/by the platform/);

    const platform = await failure(
      withTenant(TENANT, () =>
        service.set({
          actorId: admin,
          actorAuthority: 'PLATFORM',
          key: Feature.QUICK_TRADING,
          enabled: false,
          note: 'no',
        }),
      ),
    );
    expect(platform.code).toBe(TradingErrorCode.FORBIDDEN);
    expect(await prisma.tenantFeature.count()).toBe(0);
  });

  it('lets the platform set a broker’s platform flag by entering the broker’s scope', async () => {
    const platformId = await createTenant(prisma, 'the-platform', undefined, 'PLATFORM');
    const operator = (
      await withTenant({ tenantId: platformId, slug: 'the-platform', kind: 'PLATFORM' }, () =>
        createAccount(prisma, { tenantId: platformId, email: 'op@test.local' }),
      )
    ).userId;

    await withTenant({ tenantId: platformId, slug: 'the-platform', kind: 'PLATFORM' }, () =>
      service.setForBroker(operator, TENANT, Feature.EXTERNAL_EXECUTION, true, 'venue connected'),
    );
    expect(await withTenant(TENANT, () => service.isEnabled(Feature.EXTERNAL_EXECUTION))).toBe(true);

    // And not from a broker's own scope, whatever the caller claims to be.
    const fromBroker = await failure(
      withTenant(TENANT, () =>
        service.setForBroker(admin, TENANT, Feature.WEBHOOKS, false, 'pretending'),
      ),
    );
    expect(fromBroker.code).toBe(TradingErrorCode.FORBIDDEN);
  });

  it('keeps one firm’s flags out of another’s', async () => {
    const otherId = await createTenant(prisma, 'other-firm');
    const other = { tenantId: otherId, slug: 'other-firm', kind: 'BROKER' as const };
    await withTenant(TENANT, () =>
      service.set({
        actorId: admin,
        actorAuthority: 'FIRM',
        key: Feature.TRAILING_STOP,
        enabled: false,
        note: 'ours',
      }),
    );
    expect(await withTenant(other, () => service.isEnabled(Feature.TRAILING_STOP))).toBe(true);
    expect((await withTenant(other, () => service.list())).every((row) => row.override === null)).toBe(
      true,
    );
  });

  it('audits every change without a secret to leak, naming the authority', async () => {
    await withTenant(TENANT, () =>
      service.set({
        actorId: admin,
        actorAuthority: 'FIRM',
        key: Feature.QUICK_TRADING,
        enabled: false,
        note: 'compliance',
      }),
    );
    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'TenantFeature' } });
    expect(rows.map((row) => row.action)).toEqual(['FEATURE_DISABLED']);
    expect(rows[0]?.after).toMatchObject({ enabled: false, authority: 'FIRM' });
  });

  describe('enforcement', () => {
    let stack: TradingStack;

    beforeEach(async () => {
      await prisma.marketSession.deleteMany();
      await prisma.symbolSpec.deleteMany();
      await prisma.symbol.deleteMany();
      await seedTradingSymbols(prisma);
      stack = await buildTradingStack(prisma);
      await stack.publishQuote('XAUUSD', '4583.58', '4583.72');
    });

    /**
     * Setting a trail is refused when the flag is off; clearing one is not,
     * and a stop-loss without a trail is untouched — the flag is about
     * trailing, not about protecting a position.
     */
    it('refuses a new trailing stop when the firm has switched trailing off, and still lets it be cleared', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const opened = await stack.orders.openPosition(userId, {
        accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        volume: '0.10',
      });
      const positionId = opened.positionId as string;

      await withTenant(TENANT, () =>
        stack.positions.modify(userId, { positionId, trailingStopDistance: '5' }),
      );

      // Through the stack's own service, whose cache the write invalidates. A
      // second instance would see the change within the five-second window.
      await withTenant(TENANT, () =>
        stack.features.set({
          actorId: admin,
          actorAuthority: 'FIRM',
          key: Feature.TRAILING_STOP,
          enabled: false,
          note: 'off',
        }),
      );
      const refused = await failure(
        withTenant(TENANT, () =>
          stack.positions.modify(userId, { positionId, trailingStopDistance: '7' }),
        ),
      );
      expect(refused.code).toBe(TradingErrorCode.FEATURE_DISABLED);

      await withTenant(TENANT, () =>
        stack.positions.modify(userId, { positionId, trailingStopDistance: null }),
      );
      await withTenant(TENANT, () =>
        stack.positions.modify(userId, { positionId, stopLoss: '4500' }),
      );
      const row = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(row.trailingStopDistance).toBeNull();
      expect(row.stopLoss?.toString()).toBe('4500');
    });

    /**
     * An account routed to a venue while the platform has not switched external
     * execution on for this firm: refused, never quietly filled internally at
     * a price this platform made up.
     */
    it('refuses an order on a venue-routed account when external execution is off', async () => {
      const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
      const connection = await prisma.brokerConnection.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          name: 'mock venue',
          adapterKind: 'MOCK',
          enabled: true,
          createdById: userId,
        },
      });
      await prisma.account.update({
        where: { id: accountId },
        data: { executionMode: 'EXTERNAL_BROKER', brokerConnectionId: connection.id },
      });

      const refused = await failure(
        withTenant(TENANT, () =>
          stack.orders.openPosition(userId, { accountId, symbol: 'XAUUSD', side: 'BUY', volume: '0.10' }),
        ),
      );
      expect(refused.code).toBe(TradingErrorCode.FEATURE_DISABLED);
      expect(await prisma.execution.count({ where: { accountId } })).toBe(0);
    });
  });
});
