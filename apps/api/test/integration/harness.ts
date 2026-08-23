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
      audit_logs, risk_events, account_snapshots, balance_ledger,
      trades, executions, position_events, positions,
      order_events, orders, account_settings, accounts,
      refresh_tokens, users, idempotency_keys
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
