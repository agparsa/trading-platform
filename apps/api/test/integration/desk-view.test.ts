import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MasterRole, Permission } from '@tp/shared-types';
import { AuditService } from '../../src/common/audit/audit.service';
import { DeskViewService } from '../../src/master/desk-view.service';
import { MasterAccountsService } from '../../src/master/master-accounts.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
} from './harness';
import { buildTradingStack, type TradingStack } from './trading-stack';

const suite = hasTestDatabase ? describe : describe.skip;

const BID = '4583.58';
const ASK = '4583.72';

/**
 * What a desk adds up to.
 *
 * A desk is a view over accounts it has been delegated, not a container of
 * them, so everything here is a read. What these tests are about is the two
 * ways such a read goes wrong: showing an operator an account they were never
 * given, and printing a total that quietly left something out.
 */
suite('Desk view (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let masters: MasterAccountsService;
  let desks: DeskViewService;

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
    masters = new MasterAccountsService(prismaService, new AuditService(prismaService));
    desks = new DeskViewService(prismaService, stack.accountState, stack.conversion);
  });

  async function world() {
    const admin = await createAccount(prisma, { email: `admin-${Date.now()}@test.local` });
    const operator = await createAccount(prisma, {
      balance: '0',
      email: `operator-${Date.now()}@test.local`,
    });
    const alice = await createAccount(prisma, {
      balance: '100000',
      email: `alice-${Date.now()}@test.local`,
    });
    const bob = await createAccount(prisma, {
      balance: '50000',
      email: `bob-${Date.now()}@test.local`,
    });
    const master = await masters.create(admin.userId, {
      operatorUserId: operator.userId,
      name: 'Desk One',
    });
    return { admin, operator, alice, bob, master };
  }

  it('shows only the accounts the desk has actually been delegated', async () => {
    const { admin, alice, bob, master } = await world();
    await masters.grantLink(admin.userId, master.id, {
      accountId: alice.accountId,
      role: MasterRole.MASTER_VIEWER,
    });

    const view = await desks.view(master.id);
    expect(view.accounts.map((row) => row.accountId)).toEqual([alice.accountId]);
    expect(view.totals.accounts).toBe(1);
    // Bob's account exists, is funded, and is nowhere in this book.
    expect(JSON.stringify(view)).not.toContain(bob.accountId);
  });

  /**
   * A link that grants trading is a delegation to trade, not a licence to read
   * the balance. The desk book is a reading screen, so it shows what the
   * operator may read.
   */
  it('leaves out an account the desk may trade but may not read', async () => {
    const { admin, alice, master } = await world();
    await masters.grantLink(admin.userId, master.id, {
      accountId: alice.accountId,
      capabilities: [Permission.ORDERS_CREATE],
    });

    const view = await desks.view(master.id);
    expect(view.accounts).toEqual([]);
    expect(view.totals.accounts).toBe(0);
  });

  it('adds up balance, equity, margin and open positions across the desk', async () => {
    const { admin, alice, bob, master } = await world();
    for (const account of [alice, bob]) {
      await masters.grantLink(admin.userId, master.id, {
        accountId: account.accountId,
        role: MasterRole.MASTER_VIEWER,
      });
    }
    await stack.orders.openPosition(alice.userId, {
      accountId: alice.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });

    const view = await desks.view(master.id);
    expect(view.currency).toBe('USD');
    expect(view.totals.accounts).toBe(2);
    expect(view.totals.openPositions).toBe(1);
    // 100000 + 50000, less whatever commission the fill charged Alice.
    expect(Number(view.totals.balance)).toBeGreaterThan(149_000);
    expect(Number(view.totals.balance)).toBeLessThanOrEqual(150_000);
    expect(Number(view.totals.usedMargin)).toBeGreaterThan(0);
    expect(view.unpriced).toEqual([]);

    // Each account still reports its own figures beside the total.
    const rows = new Map(view.accounts.map((row) => [row.accountId, row]));
    expect(rows.get(bob.accountId)?.openPositions).toBe(0);
    expect(rows.get(alice.accountId)?.openPositions).toBe(1);
  });

  it('nets exposure by symbol across accounts, and says how many accounts hold it', async () => {
    const { admin, alice, bob, master } = await world();
    for (const account of [alice, bob]) {
      await masters.grantLink(admin.userId, master.id, {
        accountId: account.accountId,
        role: MasterRole.MASTER_VIEWER,
      });
    }
    await stack.orders.openPosition(alice.userId, {
      accountId: alice.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.30',
    });
    await stack.orders.openPosition(bob.userId, {
      accountId: bob.accountId,
      symbol: 'XAUUSD',
      side: 'SELL',
      volume: '0.10',
    });

    const [gold] = (await desks.view(master.id)).exposure;
    expect(gold?.symbol).toBe('XAUUSD');
    // Long 0.30 against short 0.10 is a desk that is net long 0.20 — which is
    // the number a risk manager needs and neither account can show.
    expect(gold?.netVolume).toBe('0.2');
    expect(gold?.accounts).toBe(2);
    expect(Number(gold?.grossNotional)).toBeGreaterThan(0);
  });

  it('is empty while the master is suspended, rather than showing a book it cannot touch', async () => {
    const { admin, alice, master } = await world();
    await masters.grantLink(admin.userId, master.id, {
      accountId: alice.accountId,
      role: MasterRole.MASTER_VIEWER,
    });
    await prisma.masterAccount.update({
      where: { id: master.id },
      data: { status: 'SUSPENDED' },
    });

    const view = await desks.view(master.id);
    expect(view.accounts).toEqual([]);
    expect(view.totals.openPositions).toBe(0);
  });

  it('drops a revoked link out of the book', async () => {
    const { admin, alice, master } = await world();
    await masters.grantLink(admin.userId, master.id, {
      accountId: alice.accountId,
      role: MasterRole.MASTER_VIEWER,
    });
    expect((await desks.view(master.id)).totals.accounts).toBe(1);

    await masters.revokeLink(admin.userId, master.id, alice.accountId);
    expect((await desks.view(master.id)).totals.accounts).toBe(0);
  });

  /**
   * The failure this service is most likely to have, and the one that would be
   * least visible: a currency it cannot convert, silently added at par. A desk
   * with a euro account would then report a total nobody could reconcile, and
   * it would look right.
   */
  it('names an account it cannot price rather than adding it at par', async () => {
    const { admin, alice, master } = await world();
    // A currency the platform knows but this market has no quote for, so no
    // rate can be had — exactly the shape of a feed gap in production.
    const exotic = await createAccount(prisma, {
      balance: '250000',
      currency: 'CHF',
      email: `exotic-${Date.now()}@test.local`,
    });
    for (const account of [alice, exotic]) {
      await masters.grantLink(admin.userId, master.id, {
        accountId: account.accountId,
        role: MasterRole.MASTER_VIEWER,
      });
    }

    const view = await desks.view(master.id);
    // Both accounts are shown, each in its own currency…
    expect(view.accounts).toHaveLength(2);
    expect(view.accounts.find((row) => row.currency === 'CHF')?.balance).toBe('250000.00');
    // …the one that could not be converted is named…
    expect(view.unpriced).toHaveLength(1);
    // …and no total is printed at all, rather than one that is quietly short.
    expect(view.totals.balance).toBe(null);
    expect(view.totals.equity).toBe(null);
    // The account count is still honest about how many accounts there are.
    expect(view.totals.accounts).toBe(2);
  });

  it('reports a desk with no links as an empty book rather than failing', async () => {
    const { master } = await world();
    const view = await desks.view(master.id);
    expect(view.name).toBe('Desk One');
    expect(view.accounts).toEqual([]);
    expect(view.exposure).toEqual([]);
    expect(view.totals.openPositions).toBe(0);
  });
});
