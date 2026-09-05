import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { BlotterService, decodeCursor } from '../../src/admin/blotter.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTenant,
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
 * The firm's own book.
 *
 * Two things must hold. It must show the whole firm — a blotter that showed
 * only what the caller owns is the account-scoped listing that already
 * existed, and answers none of the questions this exists for. And it must
 * show **only** the firm: one broker's book is not another's, and the page
 * that lists every order is the one where a leak is worth the most.
 */
suite('Blotter (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let blotter: BlotterService;

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
    blotter = new BlotterService(prisma as unknown as PrismaService);
  });

  async function trader(email: string) {
    return createAccount(prisma, { balance: '1000000', email });
  }

  const buy = (userId: string, accountId: string, volume = '0.10') =>
    stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume,
    });

  it('shows every account’s orders, not just one', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    const bob = await trader(`b-${Date.now()}@test.local`);
    await buy(alice.userId, alice.accountId);
    await buy(bob.userId, bob.accountId);

    const page = await blotter.orders({});
    expect(page.rows).toHaveLength(2);
    // The columns a person needs to act: whose account, and whose name on it.
    expect(page.rows.map((row) => row.accountId).sort()).toEqual(
      [alice.accountId, bob.accountId].sort(),
    );
    expect(page.rows.every((row) => row.accountNumber.startsWith('TP-'))).toBe(true);
    expect(page.rows.every((row) => row.ownerEmail.includes('@'))).toBe(true);
    expect(page.nextCursor).toBe(null);
  });

  it('filters by account number the way a person reads one off a ticket', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    const bob = await trader(`b-${Date.now()}@test.local`);
    await buy(alice.userId, alice.accountId);
    await buy(bob.userId, bob.accountId);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: alice.accountId } });

    const page = await blotter.orders({ accountNumber: account.number.toLowerCase() });
    expect(page.rows.map((row) => row.accountId)).toEqual([alice.accountId]);
  });

  /**
   * The failure that would matter: a mistyped digit falling through to no
   * filter at all, and showing a support agent the whole firm's book.
   */
  it('an unknown account number matches nothing, not everything', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    await buy(alice.userId, alice.accountId);

    expect((await blotter.orders({ accountNumber: 'TP-000000' })).rows).toEqual([]);
  });

  it('filters by instrument, side and status', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    await buy(alice.userId, alice.accountId);
    await stack.orders.openPosition(alice.userId, {
      accountId: alice.accountId,
      symbol: 'XAUUSD',
      side: 'SELL',
      volume: '0.10',
    });

    expect((await blotter.orders({ side: 'BUY' })).rows).toHaveLength(1);
    expect((await blotter.orders({ symbol: 'xauusd' })).rows).toHaveLength(2);
    expect((await blotter.orders({ symbol: 'EURUSD' })).rows).toEqual([]);
    expect((await blotter.orders({ status: 'FILLED' })).rows).toHaveLength(2);
    expect((await blotter.orders({ status: 'REJECTED' })).rows).toEqual([]);
  });

  it('pages by keyset, so a book that is still moving is not read twice', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    for (let i = 0; i < 5; i += 1) await buy(alice.userId, alice.accountId, '0.01');

    const first = await blotter.orders({ limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBe(null);

    const second = await blotter.orders({ limit: 2, cursor: first.nextCursor as string });
    expect(second.rows).toHaveLength(2);
    const third = await blotter.orders({ limit: 2, cursor: second.nextCursor as string });
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBe(null);

    // Five distinct orders across three pages, none repeated, none missing.
    const seen = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id);
    expect(new Set(seen).size).toBe(5);
  });

  /**
   * The case the cursor's id half exists for.
   *
   * Orders arrive in bursts, and several can share a millisecond. A cursor
   * that carried only a timestamp would either show such a pair twice or skip
   * one of them at a page boundary — and in a book of orders that is not a
   * cosmetic problem, it is a row somebody is looking for that is not there.
   */
  it('pages correctly through rows that share a timestamp', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    for (let i = 0; i < 6; i += 1) await buy(alice.userId, alice.accountId, '0.01');
    // Every order at the same instant, which a burst produces on its own.
    const at = new Date('2026-09-05T09:00:00.000Z');
    await prisma.order.updateMany({ data: { createdAt: at } });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof blotter.orders>> = await blotter.orders({
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    // Six orders, each seen exactly once.
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('refuses a page marker it cannot read rather than starting over silently', async () => {
    await expect(blotter.orders({ cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: TradingErrorCode.VALIDATION_FAILED,
    });
  });

  it('caps how much one request can ask for', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    await buy(alice.userId, alice.accountId);
    // 100000 asked for; the cap applies and the call still answers.
    expect((await blotter.orders({ limit: 100_000 })).rows).toHaveLength(1);
    expect((await blotter.orders({ limit: 0 })).rows).toHaveLength(1);
  });

  it('shows open positions by default and closed ones when asked', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    const opened = await buy(alice.userId, alice.accountId);
    expect((await blotter.positions({})).rows).toHaveLength(1);

    await stack.positions.close(alice.userId, opened.positionId as string, null);
    expect((await blotter.positions({})).rows).toEqual([]);
    const closed = await blotter.positions({ status: 'CLOSED' });
    expect(closed.rows).toHaveLength(1);
    expect(closed.rows[0]?.closedAt).not.toBe(null);
  });

  it('shows closed round trips with what each one actually cost', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    const opened = await buy(alice.userId, alice.accountId, '0.20');
    await stack.positions.close(alice.userId, opened.positionId as string, null);

    const [trade] = (await blotter.trades({})).rows;
    expect(trade?.volume).toBe('0.2');
    expect(trade?.symbol).toBe('XAUUSD');
    // The three figures a firm is asked about, all present and all decimal
    // strings — never a float that has been through JSON.
    expect(trade?.grossPnl).toMatch(/^-?\d/);
    expect(trade?.commission).toMatch(/^-?\d/);
    expect(trade?.netPnl).toMatch(/^-?\d/);
    // And they reconcile: net is gross less what dealing cost, plus swap.
    // That identity is what makes this table answerable to the ledger.
    expect(Number(trade?.netPnl)).toBeCloseTo(
      Number(trade?.grossPnl) - Number(trade?.commission) + Number(trade?.swap),
      8,
    );
  });

  it('answers “why was that rejected” from the order’s own events', async () => {
    const alice = await createAccount(prisma, { balance: '10', email: `p-${Date.now()}@test.local` });
    await expect(buy(alice.userId, alice.accountId, '5.00')).rejects.toBeInstanceOf(DomainError);
    // A refused order writes no row — so the history that exists is a real one.
    const filled = await trader(`q-${Date.now()}@test.local`);
    const result = await buy(filled.userId, filled.accountId);

    const history = await blotter.orderHistory(result.orderId);
    expect(history.order.status).toBe('FILLED');
    expect(history.events.length).toBeGreaterThan(0);
    expect(history.events[0]?.type).toBe('CREATED');
    // Ordered oldest first: a history read backwards is a history misread.
    const times = history.events.map((event) => Date.parse(event.createdAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('refuses an order id it does not hold', async () => {
    await expect(
      blotter.orderHistory('00000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({ code: TradingErrorCode.RESOURCE_NOT_FOUND });
  });

  /**
   * The page that lists every order is the page where a leak is worth the
   * most. This is the whole security claim of the feature.
   */
  it('is one firm’s book: another firm sees none of it', async () => {
    const alice = await trader(`a-${Date.now()}@test.local`);
    const opened = await buy(alice.userId, alice.accountId);
    await stack.positions.close(alice.userId, opened.positionId as string, null);

    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      expect((await blotter.orders({})).rows).toEqual([]);
      expect((await blotter.positions({ status: 'CLOSED' })).rows).toEqual([]);
      expect((await blotter.trades({})).rows).toEqual([]);
      await expect(blotter.orderHistory(opened.orderId)).rejects.toMatchObject({
        code: TradingErrorCode.RESOURCE_NOT_FOUND,
      });
    });
  });

  it('encodes a cursor that survives a round trip, and rejects a mangled one', () => {
    const at = new Date('2026-09-05T10:11:12.345Z');
    const cursor = Buffer.from(`${at.toISOString()}|abc`, 'utf8').toString('base64url');
    expect(decodeCursor(cursor)).toEqual({ at, id: 'abc' });
    expect(decodeCursor('%%%')).toBe(null);
    expect(decodeCursor(Buffer.from('no-pipe', 'utf8').toString('base64url'))).toBe(null);
    expect(decodeCursor(Buffer.from('not-a-date|abc', 'utf8').toString('base64url'))).toBe(null);
  });
});
