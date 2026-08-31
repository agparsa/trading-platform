import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Permission, UserRole, roleHasPermissions } from '@tp/shared-types';
import { AdminInstrumentsService } from '../../src/admin/instruments.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SymbolsService } from '../../src/symbols/symbols.service';
import {
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * What the platform trades, and who may change it.
 *
 * The dangerous change here is not the on/off switch. Raising a margin rate
 * changes the margin required by every position already open in that
 * instrument, and can put an account into margin call without anyone touching
 * that account. So: administrators only, both values in the audit entry, and a
 * reply that says how many positions were just affected.
 */
suite('Administering instruments (integration)', () => {
  let prisma: PrismaClient;
  let instruments: AdminInstrumentsService;
  /** A real row: the audit trail references its actor, as it should. */
  let ADMIN: string;

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

    const administrator = await prisma.user.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        email: `instruments-admin-${Date.now()}@test.local`,
        passwordHash: 'not-a-real-hash',
        displayName: 'An Administrator',
        role: 'ADMIN',
      },
    });
    ADMIN = administrator.id;

    const prismaService = prisma as unknown as PrismaService;
    const symbols = new SymbolsService(prismaService);
    await symbols.onModuleInit();
    instruments = new AdminInstrumentsService(
      prismaService,
      new AuditService(prismaService),
      symbols,
    );
  });

  it('lists what is traded, with the terms and what is open in each', async () => {
    const rows = await instruments.list();
    expect(rows.length).toBeGreaterThan(0);
    const gold = rows.find((row) => row.code === 'XAUUSD');
    expect(gold).toBeDefined();
    expect(gold?.marginRate).toBeTruthy();
    expect(gold?.openPositions).toBe(0);
    expect(gold?.restingOrders).toBe(0);
  });

  it('suspends an instrument, and the list agrees', async () => {
    const result = await instruments.setEnabled(ADMIN, 'XAUUSD', false, 'venue outage');
    expect(result).toMatchObject({ code: 'XAUUSD', enabled: false });
    const rows = await instruments.list();
    expect(rows.find((r) => r.code === 'XAUUSD')?.enabled).toBe(false);
  });

  /**
   * The reason is not decoration. Six months later the audit entry is the only
   * record of why an instrument stopped trading on a Tuesday.
   */
  it('refuses a change with no reason worth reading', async () => {
    await expect(instruments.setEnabled(ADMIN, 'XAUUSD', false, 'x')).rejects.toThrow(
      /at least 8/i,
    );
  });

  it('changes the terms and records both values', async () => {
    const before = (await instruments.list()).find((r) => r.code === 'XAUUSD');
    const result = await instruments.setTerms(
      ADMIN,
      'XAUUSD',
      { commissionPerLot: '9.5' },
      'commercial review',
    );
    expect(result.changed).toEqual(['commissionPerLot']);

    const after = (await instruments.list()).find((r) => r.code === 'XAUUSD');
    expect(after?.commissionPerLot).not.toBe(before?.commissionPerLot);

    const entries = await prisma.auditLog.findMany({
      where: { action: 'instrument.terms_changed' },
    });
    expect(entries).toHaveLength(1);
    // Both values: an entry saying only "commission changed" is no use at all.
    expect(JSON.stringify(entries[0]?.before)).toContain('commissionPerLot');
    expect(JSON.stringify(entries[0]?.after)).toContain('9.5');
  });

  it('writes no audit entry when nothing actually changed', async () => {
    const current = (await instruments.list()).find((r) => r.code === 'XAUUSD');
    const result = await instruments.setTerms(
      ADMIN,
      'XAUUSD',
      { commissionPerLot: current?.commissionPerLot ?? '0' },
      'no change at all',
    );
    expect(result.changed).toEqual([]);
    expect(await prisma.auditLog.count({ where: { action: 'instrument.terms_changed' } })).toBe(0);
  });

  /**
   * No legitimate configuration means this: it lets an account open a position
   * of any size against nothing.
   */
  it('refuses a margin rate of zero', async () => {
    await expect(
      instruments.setTerms(ADMIN, 'XAUUSD', { marginRate: '0' }, 'testing the guard'),
    ).rejects.toThrow(/any size against nothing/i);
  });

  it('refuses an instrument it does not have', async () => {
    await expect(instruments.setEnabled(ADMIN, 'NOTREAL', false, 'does not exist')).rejects.toThrow(
      /No such instrument/i,
    );
  });

  it('is administrators only', () => {
    for (const role of Object.values(UserRole)) {
      expect(roleHasPermissions(role, [Permission.INSTRUMENTS_MANAGE])).toBe(
        role === UserRole.ADMIN,
      );
    }
  });
});
