import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, MasterRole, TradingErrorCode } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { AuditService } from '../../src/common/audit/audit.service';
import { MasterAccountsService } from '../../src/master/master-accounts.service';
import { RiskHierarchyService } from '../../src/admin/risk-hierarchy.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTenant,
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

/**
 * Platform → broker → desk → account, each only stricter.
 *
 * Two things must hold, and they are separate. **Nothing below may loosen
 * what is above** — checked when a limit is written, so a person is told, and
 * again when it is read, so a row that arrived some other way cannot widen
 * anything. And **the ceiling actually stops an order**, which is the only
 * claim that matters: a hierarchy that resolves beautifully and is never
 * consulted is a configuration screen, not a risk control.
 */
suite('Risk hierarchy (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let hierarchy: RiskHierarchyService;
  let masters: MasterAccountsService;
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
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
    stack = await buildTradingStack(prisma);
    await stack.publishQuote('XAUUSD', BID, ASK);

    const prismaService = prisma as unknown as PrismaService;
    const audit = new AuditService(prismaService);
    hierarchy = new RiskHierarchyService(prismaService, audit);
    masters = new MasterAccountsService(prismaService, audit);
    actorId = (
      await prisma.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email: `risk-${Date.now()}@test.local`,
          passwordHash: 'not-a-real-hash',
          displayName: 'Risk',
          role: 'RISK_MANAGER',
        },
      })
    ).id;
  });

  async function codeOf(action: () => Promise<unknown>): Promise<string> {
    try {
      await action();
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
    throw new Error('the operation succeeded — it should have been refused');
  }

  const buy = (userId: string, accountId: string, volume: string) =>
    stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume,
    });

  it('a broker ceiling stops an order the account itself would have allowed', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    // The account is configured for two lots; the firm caps everyone at one.
    await prisma.accountSettings.update({
      where: { accountId },
      data: { maxPositionVolume: '2.00' },
    });
    await hierarchy.setBroker(actorId, { maxPositionVolume: '1.00' });

    await expect(buy(userId, accountId, '1.50')).rejects.toMatchObject({
      code: TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
    });
    // And what fits under the firm's ceiling still trades.
    expect((await buy(userId, accountId, '0.90')).status).toBe('FILLED');
  });

  it('the platform ceiling binds a firm that never set one of its own', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    await prisma.accountSettings.update({
      where: { accountId },
      data: { maxPositionVolume: '5.00' },
    });
    // The default tenant is the platform tenant in this harness.
    await hierarchy.setPlatform(actorId, { maxPositionVolume: '0.50' });

    await expect(buy(userId, accountId, '1.00')).rejects.toMatchObject({
      code: TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
    });
    expect((await buy(userId, accountId, '0.40')).status).toBe('FILLED');
  });

  it('takes the tightest layer, not the nearest one', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    await hierarchy.setPlatform(actorId, { maxPositionVolume: '0.30' });
    // The account is looser than the platform. Written directly, as a bad
    // migration or a restored backup would: the resolver must still clamp it.
    await prisma.accountSettings.update({
      where: { accountId },
      data: { maxPositionVolume: '9.00' },
    });

    await expect(buy(userId, accountId, '0.50')).rejects.toMatchObject({
      code: TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
    });
  });

  it('a layer that says nothing passes the layer above through, rather than meaning unlimited', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    await hierarchy.setPlatform(actorId, { maxPositionVolume: '0.50' });
    // The firm sets a different field entirely and stays silent on volume.
    await hierarchy.setBroker(actorId, { maxOpenPositions: 5 });

    await expect(buy(userId, accountId, '1.00')).rejects.toMatchObject({
      code: TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
    });
  });

  it('with no layer set at all, nothing new is enforced', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '1000000' });
    expect((await buy(userId, accountId, '1.00')).status).toBe('FILLED');
  });

  describe('a layer may tighten and may never loosen', () => {
    it('refuses a broker ceiling looser than the platform, and names the layer', async () => {
      await hierarchy.setPlatform(actorId, { maxPositionVolume: '1.00' });

      const error = await hierarchy
        .setBroker(actorId, { maxPositionVolume: '5.00' })
        .then(() => null)
        .catch((e: unknown) => e as DomainError);
      expect(error).toBeInstanceOf(DomainError);
      if (error === null) throw new Error('the loose ceiling was accepted');
      expect(error.code).toBe(TradingErrorCode.VALIDATION_FAILED);
      // The message has to be actionable: which layer, and what it allows.
      expect(error.message).toContain('platform');
      expect(error.message).toContain('1');
      // Nothing was saved.
      expect(await prisma.riskLimitSet.count({ where: { level: 'BROKER' } })).toBe(0);
    });

    it('allows a tighter one, and allows restating the same value', async () => {
      await hierarchy.setPlatform(actorId, { maxPositionVolume: '1.00' });
      expect(
        (await hierarchy.setBroker(actorId, { maxPositionVolume: '0.50' })).maxPositionVolume,
      ).toBe('0.5');
      expect(
        (await hierarchy.setBroker(actorId, { maxPositionVolume: '1.00' })).maxPositionVolume,
      ).toBe('1');
    });

    it('refuses a desk ceiling looser than either layer above it', async () => {
      const admin = await createAccount(prisma, { email: `a-${Date.now()}@test.local` });
      const operator = await createAccount(prisma, { email: `o-${Date.now()}@test.local` });
      const master = await masters.create(admin.userId, {
        operatorUserId: operator.userId,
        name: 'Desk One',
      });
      await hierarchy.setPlatform(actorId, { maxPositionVolume: '2.00' });
      await hierarchy.setBroker(actorId, { maxPositionVolume: '1.00' });

      // Looser than the broker, though tighter than the platform.
      expect(
        await codeOf(() => hierarchy.setDesk(actorId, master.id, { maxPositionVolume: '1.50' })),
      ).toBe(TradingErrorCode.VALIDATION_FAILED);
      expect(
        (await hierarchy.setDesk(actorId, master.id, { maxPositionVolume: '0.25' }))
          .maxPositionVolume,
      ).toBe('0.25');
    });

    it('refuses an account configured looser than the layers above it', async () => {
      const { accountId } = await createAccount(prisma, { balance: '1000' });
      await hierarchy.setBroker(actorId, { maxOpenPositions: 3 });

      expect(await codeOf(() => hierarchy.assertWithinCeiling({ maxOpenPositions: 10 }))).toBe(
        TradingErrorCode.VALIDATION_FAILED,
      );
      // And the account keeps whatever it had, rather than a half-applied set.
      const settings = await prisma.accountSettings.findUniqueOrThrow({ where: { accountId } });
      expect(settings.maxOpenPositions).toBe(null);
    });

    it('compares decimals as numbers, not as text', async () => {
      // '9' sorts after '10' as text. A ceiling compared lexically is a
      // ceiling that is sometimes exactly the wrong way round.
      await hierarchy.setPlatform(actorId, { maxPositionVolume: '10.00' });
      expect(
        (await hierarchy.setBroker(actorId, { maxPositionVolume: '9.00' })).maxPositionVolume,
      ).toBe('9');
      expect(await codeOf(() => hierarchy.setBroker(actorId, { maxPositionVolume: '11.00' }))).toBe(
        TradingErrorCode.VALIDATION_FAILED,
      );
    });
  });

  describe('the desk layer binds the route, not the account', () => {
    async function desk() {
      const admin = await createAccount(prisma, { email: `a-${Date.now()}@test.local` });
      const operator = await createAccount(prisma, {
        balance: '0',
        email: `o-${Date.now()}@test.local`,
      });
      const holder = await createAccount(prisma, {
        balance: '1000000',
        email: `h-${Date.now()}@test.local`,
      });
      const master = await masters.create(admin.userId, {
        operatorUserId: operator.userId,
        name: 'Desk One',
      });
      await masters.grantLink(admin.userId, master.id, {
        accountId: holder.accountId,
        role: MasterRole.MASTER_TRADER,
      });
      return { admin, operator, holder, master };
    }

    it('stops an operator at the desk ceiling', async () => {
      const { operator, holder, master } = await desk();
      await hierarchy.setDesk(actorId, master.id, { maxPositionVolume: '0.20' });

      await expect(buy(operator.userId, holder.accountId, '0.50')).rejects.toMatchObject({
        code: TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
      });
      expect((await buy(operator.userId, holder.accountId, '0.10')).status).toBe('FILLED');
    });

    /**
     * The point of the desk layer. "My operators may not put on more than a
     * fifth of a lot" is a statement about the operators — the account holder
     * never agreed to it and is not bound by it on their own account.
     */
    it('does not bind the account holder trading their own account', async () => {
      const { operator, holder, master } = await desk();
      await hierarchy.setDesk(actorId, master.id, { maxPositionVolume: '0.20' });

      expect((await buy(holder.userId, holder.accountId, '1.00')).status).toBe('FILLED');
      await expect(buy(operator.userId, holder.accountId, '1.00')).rejects.toMatchObject({
        code: TradingErrorCode.MAX_POSITION_SIZE_EXCEEDED,
      });
    });

    /**
     * A resting order fills later, from the tick loop, with no caller. The
     * ceiling that governed its placement has to travel with it, or an
     * operator under a desk cap could place orders now and have them fill
     * unconstrained afterwards.
     */
    it('binds a pending order at its fill by the desk that placed it', async () => {
      const { operator, holder, master } = await desk();
      await hierarchy.setDesk(actorId, master.id, { maxOpenPositions: 1 });

      const first = await stack.orders.placePending(operator.userId, {
        accountId: holder.accountId,
        symbol: 'XAUUSD',
        side: 'BUY',
        type: 'LIMIT',
        volume: '0.10',
        price: '4000.00',
      });
      const row = await prisma.order.findUniqueOrThrow({ where: { id: first.orderId } });
      expect(row.placedByMasterAccountId).toBe(master.id);

      // One position already open, placed by the same operator.
      await buy(operator.userId, holder.accountId, '0.10');
      // The resting order now cannot fill: the desk allows one open position.
      await stack.publishQuote('XAUUSD', '3999.00', '3999.10');
      await stack.triggers.onTick({
        symbol: 'XAUUSD',
        bid: '3999.00',
        ask: '3999.10',
        timestamp: Date.now(),
        volume: '1',
      });
      const after = await prisma.order.findUniqueOrThrow({ where: { id: first.orderId } });
      expect(after.status).not.toBe('FILLED');
      expect(await prisma.position.count({ where: { accountId: holder.accountId } })).toBe(1);
    });

    it("records an owner's own order as belonging to no desk", async () => {
      const { holder } = await desk();
      const result = await buy(holder.userId, holder.accountId, '0.10');
      const row = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } });
      expect(row.placedByMasterAccountId).toBe(null);
    });
  });

  it('is one firm’s: another firm neither sees nor is bound by this ceiling', async () => {
    await hierarchy.setBroker(actorId, { maxPositionVolume: '0.10' });
    const otherId = await createTenant(prisma, 'other-firm');

    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      const rows = await prisma.riskLimitSet.findMany({ where: { level: 'BROKER' } });
      expect(rows).toEqual([]);
    });
  });

  it('refuses to set the platform ceiling from a broker, whatever they hold', async () => {
    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      expect(await codeOf(() => hierarchy.setPlatform(actorId, { maxPositionVolume: '99' }))).toBe(
        TradingErrorCode.FORBIDDEN,
      );
    });
  });

  it('records who changed a ceiling and what it was before', async () => {
    await hierarchy.setBroker(actorId, { maxPositionVolume: '2.00' });
    await hierarchy.setBroker(actorId, { maxPositionVolume: '1.00' });

    const trail = await prisma.auditLog.findMany({
      where: { action: 'risk_limits.set' },
      orderBy: { createdAt: 'asc' },
    });
    expect(trail).toHaveLength(2);
    expect(trail[0]?.actorId).toBe(actorId);
    expect(trail[1]?.before).toMatchObject({ maxPositionVolume: '2' });
    expect(trail[1]?.after).toMatchObject({ maxPositionVolume: '1', level: 'BROKER' });
  });

  it('keeps one set per layer, so the effective ceiling cannot depend on row order', async () => {
    await hierarchy.setBroker(actorId, { maxPositionVolume: '2.00' });
    await hierarchy.setBroker(actorId, { maxPositionVolume: '1.00' });
    expect(await prisma.riskLimitSet.count({ where: { level: 'BROKER' } })).toBe(1);

    // And the database refuses a second one written around the service.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO risk_limit_sets (id, level, tenant_id, updated_at)
         VALUES (gen_random_uuid(), 'BROKER', $1, now())`,
        DEFAULT_TENANT_ID,
      ),
    ).rejects.toThrow();
  });

  it('refuses a row that claims to be a broker ceiling while naming one desk', async () => {
    const admin = await createAccount(prisma, { email: `a-${Date.now()}@test.local` });
    const operator = await createAccount(prisma, { email: `o-${Date.now()}@test.local` });
    const master = await masters.create(admin.userId, {
      operatorUserId: operator.userId,
      name: 'Desk One',
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO risk_limit_sets (id, level, tenant_id, master_account_id, updated_at)
         VALUES (gen_random_uuid(), 'BROKER', $1, $2, now())`,
        DEFAULT_TENANT_ID,
        master.id,
      ),
    ).rejects.toThrow();
  });
});
