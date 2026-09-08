import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { windowOf, type Tick } from '@tp/market-core';
import { withTenant } from '@tp/tenancy';
import { PriceAlertsService } from '../../src/alerts/price-alerts.service';
import { PriceAlertsRunner } from '../../src/alerts/price-alerts.runner';
import { LeaderLoop, type LeadershipService } from '../../src/leadership/leadership.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { SymbolsService } from '../../src/symbols/symbols.service';
import type { TenantResolver } from '../../src/tenancy/tenant-resolver.service';
import { TickBus } from '../../src/market/tick-bus';
import type { NotificationsService } from '../../src/notifications/notifications.service';
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

const suite = hasTestDatabase ? describe : describe.skip;

const TENANT = { tenantId: DEFAULT_TENANT_ID, slug: DEFAULT_TENANT_SLUG };

/**
 * "Tell me when gold reaches 4600."
 *
 * The two things that must not happen are a trader told twice about one level,
 * and a trader not told at all because the market gapped through it. Everything
 * else here is about who may see and cancel whose.
 */
suite('price alerts', () => {
  let prisma: PrismaClient;
  let service: PriceAlertsService;
  let runner: PriceAlertsRunner;
  let raised: Array<Record<string, unknown>>;
  let leading: boolean;

  const tick = (bid: string, ask: string): Tick => ({
    symbol: 'XAUUSD',
    bid,
    ask,
    timestamp: Date.now(),
    volume: '1',
  });

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

    const prismaService = prisma as unknown as PrismaService;
    const symbols = new SymbolsService(prismaService);
    await symbols.reload();

    raised = [];
    const notifications = {
      raise: async (job: Record<string, unknown>) => {
        raised.push(job);
      },
    } as unknown as NotificationsService;

    service = new PriceAlertsService(
      prismaService,
      symbols,
      notifications,
      new AuditService(prismaService),
    );

    leading = true;
    runner = new PriceAlertsRunner(
      new ConfigService({
        PRICE_ALERTS_ENABLED: true,
        PRICE_ALERT_SWEEP_INTERVAL_MS: 1_000,
      } as never) as never,
      prismaService,
      new TickBus(),
      service,
      {
        isLeading: (loop: string) => loop === LeaderLoop.PRICE_ALERTS && leading,
        campaign: () => undefined,
      } as unknown as LeadershipService,
      {
        byId: (tenantId: string) => Promise.resolve({ tenantId, slug: DEFAULT_TENANT_SLUG }),
      } as unknown as TenantResolver,
    );
  });

  const trader = async () => {
    const { userId } = await createAccount(prisma, { balance: '100000' });
    return userId;
  };

  const alertAt = async (
    userId: string,
    condition: 'ABOVE' | 'BELOW',
    price: string,
    extra: Record<string, unknown> = {},
  ) =>
    withTenant(TENANT, () =>
      service.create(userId, { symbol: 'XAUUSD', condition, price, ...extra }),
    );

  it('fires once when the market reaches the level', async () => {
    const userId = await trader();
    const alert = await alertAt(userId, 'ABOVE', '4600');

    runner.onTick(tick('4601.00', '4601.14'));
    expect(await runner.sweep()).toBe(1);

    const row = await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(row.status).toBe('TRIGGERED');
    expect(row.triggeredAt).not.toBeNull();
    expect(raised).toHaveLength(1);
    expect(raised[0]?.['kind']).toBe('price.alert');
  });

  /**
   * The reason it fires once rather than "once per pass". A level crossed back
   * and forth in a volatile minute would otherwise produce a notification per
   * oscillation, which is how a trader learns to ignore them.
   */
  it('does not fire the same alert again on the next pass', async () => {
    const userId = await trader();
    await alertAt(userId, 'ABOVE', '4600');

    runner.onTick(tick('4601.00', '4601.14'));
    await runner.sweep();
    runner.onTick(tick('4602.00', '4602.14'));
    expect(await runner.sweep()).toBe(0);

    expect(raised).toHaveLength(1);
  });

  /**
   * A market that jumps from 4590 to 4610 has passed 4600. A trader who asked
   * to be told at 4600 is not helped by silence because no tick printed there.
   */
  it('fires on a level the market gapped straight through', async () => {
    const userId = await trader();
    await alertAt(userId, 'ABOVE', '4600');

    runner.onTick(tick('4590.00', '4590.14'));
    runner.onTick(tick('4610.00', '4610.14'));
    expect(await runner.sweep()).toBe(1);
  });

  it('reports the price as it stands, not the extreme that triggered it', async () => {
    const userId = await trader();
    const alert = await alertAt(userId, 'ABOVE', '4600');

    // Up through the level, then back below it before the pass runs.
    runner.onTick(tick('4610.00', '4610.14'));
    runner.onTick(tick('4593.00', '4593.14'));
    await runner.sweep();

    const row = await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(row.triggeredPrice?.toString()).toBe('4593');
  });

  it('stays quiet while the market is short of the level', async () => {
    const userId = await trader();
    await alertAt(userId, 'ABOVE', '4600');

    runner.onTick(tick('4599.99', '4600.13'));
    expect(await runner.sweep()).toBe(0);
    expect(raised).toHaveLength(0);
  });

  it('watches the half of the book it was told to', async () => {
    const userId = await trader();
    await alertAt(userId, 'ABOVE', '4600', { source: 'ASK' });

    // The bid is short of the level; the ask is not.
    runner.onTick(tick('4599.90', '4600.10'));
    expect(await runner.sweep()).toBe(1);
  });

  /**
   * Evaluation runs under a lease, so a second instance should not exist. The
   * conditional write is what makes "should not" not a thing a trader is
   * notified on the strength of.
   */
  it('sends one notification even if two instances evaluate the same tick', async () => {
    const userId = await trader();
    const alert = await alertAt(userId, 'ABOVE', '4600');
    const row = await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert.id } });

    const both = await Promise.all([
      withTenant(TENANT, () =>
        service.evaluate(row, windowOf(tick('4601.00', '4601.14')), {
          bid: '4601.00',
          ask: '4601.14',
        }),
      ),
      withTenant(TENANT, () =>
        service.evaluate(row, windowOf(tick('4601.00', '4601.14')), {
          bid: '4601.00',
          ask: '4601.14',
        }),
      ),
    ]);

    expect(both.filter(Boolean)).toHaveLength(1);
    expect(raised).toHaveLength(1);
  });

  it('retires an expired alert instead of firing it', async () => {
    const userId = await trader();
    const alert = await withTenant(TENANT, () =>
      service.create(userId, {
        symbol: 'XAUUSD',
        condition: 'ABOVE',
        price: '4600',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    // Time passes.
    await prisma.priceAlert.update({
      where: { id: alert.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    runner.onTick(tick('4601.00', '4601.14'));
    expect(await runner.sweep()).toBe(0);

    const row = await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(row.status).toBe('EXPIRED');
    expect(raised).toHaveLength(0);
  });

  it('does nothing at all when this instance does not hold the lease', async () => {
    const userId = await trader();
    const alert = await alertAt(userId, 'ABOVE', '4600');

    leading = false;
    runner.onTick(tick('4601.00', '4601.14'));
    expect(await runner.sweep()).toBe(0);

    const row = await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(row.status).toBe('ACTIVE');
    expect(raised).toHaveLength(0);
  });

  /**
   * An alert id is a UUID somebody might paste. "Cancel by id" that trusts the
   * id is how one trader silences another's.
   */
  it('refuses to cancel somebody else’s alert', async () => {
    const owner = await trader();
    const other = await trader();
    const alert = await alertAt(owner, 'ABOVE', '4600');

    await expect(withTenant(TENANT, () => service.cancel(other, alert.id))).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });

    const row = await prisma.priceAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('shows a person only their own alerts', async () => {
    const owner = await trader();
    const other = await trader();
    await alertAt(owner, 'ABOVE', '4600');

    expect(await withTenant(TENANT, () => service.list(owner))).toHaveLength(1);
    expect(await withTenant(TENANT, () => service.list(other))).toHaveLength(0);
  });

  it('refuses an alert on an instrument that does not exist', async () => {
    const userId = await trader();
    await expect(
      withTenant(TENANT, () =>
        service.create(userId, { symbol: 'NOTHING', condition: 'ABOVE', price: '1' }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a level that is not a positive number', async () => {
    const userId = await trader();
    await expect(alertAt(userId, 'ABOVE', '0')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses an expiry in the past', async () => {
    const userId = await trader();
    await expect(
      alertAt(userId, 'ABOVE', '4600', { expiresAt: new Date(Date.now() - 1_000) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  /**
   * The sweep reads every active alert on an instrument on every pass. One
   * person with fifty thousand of them is not their problem — it is everybody's.
   */
  it('caps how many active alerts one person may hold', async () => {
    const userId = await trader();
    await prisma.priceAlert.createMany({
      data: Array.from({ length: 200 }, () => ({
        tenantId: DEFAULT_TENANT_ID,
        userId,
        symbol: 'XAUUSD',
        condition: 'ABOVE' as const,
        price: '4600',
        updatedAt: new Date(),
      })),
    });

    await expect(alertAt(userId, 'ABOVE', '4600')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('records the firing in the audit trail', async () => {
    const userId = await trader();
    const alert = await alertAt(userId, 'ABOVE', '4600');

    runner.onTick(tick('4601.00', '4601.14'));
    await runner.sweep();

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'PRICE_ALERT_TRIGGERED', resourceId: alert.id },
    });
    expect(entry.actorType).toBe('SYSTEM');
  });
});
