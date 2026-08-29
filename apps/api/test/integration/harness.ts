import { PrismaClient } from '@prisma/client';

/**
 * Integration-test harness.
 *
 * These tests run against a real PostgreSQL database, because the behaviour
 * being checked — row locks, unique constraints, transaction boundaries — does
 * not exist in a mock. A mocked `FOR UPDATE` proves nothing.
 *
 * They skip themselves when `TEST_DATABASE_URL` is unset so that `pnpm test`
 * still runs on a machine with no database. CI always sets it.
 */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
export const hasTestDatabase =
  typeof TEST_DATABASE_URL === 'string' && TEST_DATABASE_URL.length > 0;

export function createTestClient(): PrismaClient {
  if (!hasTestDatabase) throw new Error('TEST_DATABASE_URL is not set');
  return new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
}

/**
 * Empties every table the tests write to.
 *
 * Order matters only in that TRUNCATE ... CASCADE handles the foreign keys for
 * us; RESTART IDENTITY keeps sequence values from drifting between runs so a
 * failure is reproducible.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      integrity_signal_events, integrity_signals,
      master_account_links, master_accounts,
      audit_logs, risk_events, account_snapshots, balance_ledger,
      trades, executions, position_events, positions,
      order_events, orders, account_settings, accounts,
      totp_recovery_codes, refresh_tokens, users, idempotency_keys
    RESTART IDENTITY CASCADE
  `);
}

export async function seedSymbols(prisma: PrismaClient): Promise<void> {
  const symbol = await prisma.symbol.upsert({
    where: { code: 'XAUUSD' },
    create: {
      code: 'XAUUSD',
      description: 'Gold vs US Dollar',
      category: 'Metals',
      quoteCurrency: 'USD',
    },
    update: {},
  });
  await prisma.symbolSpec.upsert({
    where: { symbolId: symbol.id },
    create: {
      symbolId: symbol.id,
      contractSize: '100',
      tickSize: '0.01',
      pricePrecision: 2,
      volumeStep: '0.01',
      volumePrecision: 2,
      minVolume: '0.01',
      maxVolume: '100',
      marginRate: '0.01',
      commissionPerLot: '0',
      swapLongPerLot: '-12.5',
      swapShortPerLot: '4.75',
    },
    update: {},
  });
}

/** Creates a user and one funded account directly, bypassing the HTTP layer. */
export async function createAccount(
  prisma: PrismaClient,
  options: { balance?: string; currency?: string; email?: string } = {},
): Promise<{ userId: string; accountId: string; currency: string }> {
  const currency = options.currency ?? 'USD';
  const suffix = Math.floor(Number(process.hrtime.bigint() % 1_000_000_000n));
  const user = await prisma.user.create({
    data: {
      email: options.email ?? `trader-${suffix}@test.local`,
      passwordHash: 'not-a-real-hash',
      displayName: 'Test Trader',
    },
  });
  const numbers = await prisma.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('account_number_seq') AS value
  `;
  const account = await prisma.account.create({
    data: {
      userId: user.id,
      number: `TP-${numbers[0]?.value.toString() ?? '0'}`,
      type: 'DEMO',
      currency,
      balance: '0',
      settings: { create: {} },
    },
  });
  if (options.balance !== undefined) {
    await prisma.balanceLedger.create({
      data: {
        accountId: account.id,
        type: 'DEPOSIT',
        amount: options.balance,
        balanceAfter: options.balance,
        currency,
        description: 'test opening balance',
      },
    });
    await prisma.account.update({
      where: { id: account.id },
      data: { balance: options.balance },
    });
  }
  return { userId: user.id, accountId: account.id, currency };
}

/**
 * Seeds XAUUSD with a round-the-clock session.
 *
 * Trading tests must not depend on what day it is. The real XAUUSD session
 * closes at weekends, which would make the whole suite fail every Saturday —
 * so the session calendar is tested directly (see market/session.test.ts) and
 * neutralised here.
 */
export async function seedTradingSymbols(prisma: PrismaClient): Promise<void> {
  await seedSymbols(prisma);
  const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
  await prisma.marketSession.deleteMany({ where: { symbolId: symbol.id } });
  await prisma.marketSession.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      symbolId: symbol.id,
      timezone: 'UTC',
      dayOfWeek,
      openMinute: 0,
      closeMinute: 1440,
    })),
  });
}

/** Seeds an instrument whose session never opens, for the market-closed case. */
export async function seedClosedSymbol(prisma: PrismaClient): Promise<void> {
  const symbol = await prisma.symbol.upsert({
    where: { code: 'CLOSEDX' },
    create: {
      code: 'CLOSEDX',
      description: 'Permanently closed instrument',
      category: 'Test',
      quoteCurrency: 'USD',
    },
    update: {},
  });
  await prisma.symbolSpec.upsert({
    where: { symbolId: symbol.id },
    create: {
      symbolId: symbol.id,
      contractSize: '100',
      tickSize: '0.01',
      pricePrecision: 2,
      volumeStep: '0.01',
      volumePrecision: 2,
      minVolume: '0.01',
      maxVolume: '100',
      marginRate: '0.01',
      commissionPerLot: '0',
      swapLongPerLot: '0',
      swapShortPerLot: '0',
    },
    update: {},
  });
  await prisma.marketSession.deleteMany({ where: { symbolId: symbol.id } });
}

/**
 * An instrument quoted in a currency that is not the account's.
 *
 * USDJPY is the platform's first such instrument, and it exists for exactly
 * this reason: every other listed contract settles its P&L in USD, so the whole
 * conversion path — `ConversionService`, and the `quoteToAccountRate` that
 * multiplies P&L, margin and exposure on every foreign-quoted position — was
 * reachable in production and exercised by nothing.
 *
 * Its session is open every minute of the week so a test does not depend on
 * which day it runs.
 */
export async function seedJpySymbol(prisma: PrismaClient): Promise<void> {
  const symbol = await prisma.symbol.upsert({
    where: { code: 'USDJPY' },
    create: {
      code: 'USDJPY',
      description: 'US Dollar vs Japanese Yen',
      category: 'FX',
      quoteCurrency: 'JPY',
    },
    update: { quoteCurrency: 'JPY' },
  });
  await prisma.symbolSpec.upsert({
    where: { symbolId: symbol.id },
    create: {
      symbolId: symbol.id,
      contractSize: '100000',
      tickSize: '0.001',
      pricePrecision: 3,
      volumeStep: '0.01',
      volumePrecision: 2,
      minVolume: '0.01',
      maxVolume: '200',
      marginRate: '0.002',
      commissionPerLot: '3.5',
      swapLongPerLot: '1.8',
      swapShortPerLot: '-3.2',
    },
    update: {},
  });
  await prisma.marketSession.deleteMany({ where: { symbolId: symbol.id } });
  await prisma.marketSession.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      symbolId: symbol.id,
      timezone: 'UTC',
      dayOfWeek,
      openMinute: 0,
      closeMinute: 1440,
    })),
  });
}
