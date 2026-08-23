import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { SymbolsService } from '../../src/symbols/symbols.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { createTestClient, hasTestDatabase, resetDatabase, seedSymbols } from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

suite('SymbolsService (integration)', () => {
  let prisma: PrismaClient;
  let symbols: SymbolsService;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    symbols = new SymbolsService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
  });

  it('loads an instrument with its contract specification', async () => {
    await seedSymbols(prisma);
    expect(await symbols.reload()).toBe(1);

    const spec = symbols.requireSpec('XAUUSD');
    expect(spec.contractSize).toBe('100');
    expect(spec.tickSize).toBe('0.01');
    expect(spec.marginRate).toBe('0.01');
  });

  it('matches a symbol code case-insensitively', async () => {
    await seedSymbols(prisma);
    await symbols.reload();
    expect(symbols.requireSpec('xauusd').code).toBe('XAUUSD');
  });

  it('throws UNKNOWN_SYMBOL rather than returning nothing', async () => {
    await seedSymbols(prisma);
    await symbols.reload();
    expect(() => symbols.require('NOPE')).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_SYMBOL' }),
    );
  });

  /**
   * A symbol whose tick size is finer than its stored precision cannot be
   * priced consistently. It must be refused at load, not discovered when an
   * order is placed against it.
   */
  it('refuses to load an instrument with an inconsistent specification', async () => {
    await seedSymbols(prisma);
    const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
    await prisma.symbolSpec.update({
      where: { symbolId: symbol.id },
      data: { tickSize: '0.00001' }, // needs 5 decimals; pricePrecision is 2
    });

    expect(await symbols.reload()).toBe(0);
    expect(() => symbols.require('XAUUSD')).toThrow();
  });

  it('refuses to load an instrument with no specification at all', async () => {
    await prisma.symbol.create({
      data: {
        code: 'GHOST',
        description: 'No spec',
        category: 'Test',
        quoteCurrency: 'USD',
      },
    });
    expect(await symbols.reload()).toBe(0);
  });

  it('carries the session windows through, ordered by day', async () => {
    await seedSymbols(prisma);
    const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
    await prisma.marketSession.createMany({
      data: [
        { symbolId: symbol.id, dayOfWeek: 3, openMinute: 0, closeMinute: 1440 },
        { symbolId: symbol.id, dayOfWeek: 1, openMinute: 0, closeMinute: 1440 },
      ],
    });
    await symbols.reload();
    expect(symbols.require('XAUUSD').session.windows.map((w) => w.day)).toEqual([1, 3]);
  });

  it('reflects an administrative change only after a reload', async () => {
    await seedSymbols(prisma);
    await symbols.reload();
    const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });

    await prisma.symbolSpec.update({
      where: { symbolId: symbol.id },
      data: { marginRate: '0.05' },
    });
    // The cache is deliberately not invalidated by a database write; changing a
    // margin rate mid-session must be an explicit act.
    expect(symbols.requireSpec('XAUUSD').marginRate).toBe('0.01');

    await symbols.reload();
    expect(symbols.requireSpec('XAUUSD').marginRate).toBe('0.05');
  });
});
