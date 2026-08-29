import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainEvent } from '@tp/shared-types';
import { ExposureIndex } from '../../src/realtime/exposure-index';
import { EventsService } from '../../src/realtime/events.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
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

/** Redis is not what this is about; the local handler path is. */
const fakeRedis = {
  publisher: { publish: async () => 1 },
  subscriber: { subscribe: async () => 1, on: () => undefined, unsubscribe: async () => 1 },
} as unknown as RedisService;

/**
 * The symbol→accounts routing index.
 *
 * This replaced a `position.findMany` that ran on every tick, so the thing worth
 * testing is not that it is fast — it is that it never *under*-reports. An
 * account missing from a symbol it holds sees its P&L stop moving, which looks
 * exactly like a broken terminal; an account listed against a symbol it no
 * longer holds costs one wasted valuation and nothing else.
 *
 * So the asymmetry is the specification, and every case below is written against
 * it rather than against "the index matches the database".
 */
suite('Exposure index (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let events: EventsService;

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
    events = new EventsService(fakeRedis);
  });

  /**
   * A Prisma stand-in that counts reads and can be told to fail.
   *
   * Deliberately a wrapper rather than `vi.spyOn(prisma.position, 'findMany')`.
   * Prisma's model delegates are lazily-defined properties, so restoring a spy
   * on one removes the method rather than putting it back, and the next test in
   * the file dies with "findMany is not a function" — which is a fault in the
   * test file, not in the code under test, and takes far longer to recognise
   * than it should.
   */
  function watched(options: { failNext?: boolean } = {}) {
    let calls = 0;
    let failNext = options.failNext ?? false;
    const client = {
      position: {
        findMany: async (args: unknown) => {
          calls += 1;
          if (failNext) {
            failNext = false;
            throw new Error('database unavailable');
          }
          return prisma.position.findMany(args as never);
        },
      },
    } as unknown as PrismaService;
    return {
      client,
      get calls() {
        return calls;
      },
      failOnce() {
        failNext = true;
      },
    };
  }

  const build = (refreshMs = 30_000) =>
    new ExposureIndex(prisma as unknown as PrismaService, events, refreshMs);

  async function traderWithPosition(volume = '1.00') {
    const trader = await createAccount(prisma, { balance: '100000' });
    const opened = await stack.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume,
    });
    if (opened.positionId === null) throw new Error('no position opened');
    return { ...trader, positionId: opened.positionId };
  }

  it('finds an account holding the symbol, without being told', async () => {
    const trader = await traderWithPosition();
    const index = build();

    const exposed = await index.exposedTo('XAUUSD', new Set([trader.accountId]), Date.now());
    expect(exposed).toEqual([trader.accountId]);
  });

  it('reports nothing for a symbol the account does not hold', async () => {
    const trader = await traderWithPosition();
    const index = build();

    expect(await index.exposedTo('BTCUSD', new Set([trader.accountId]), Date.now())).toEqual([]);
  });

  it('never reports an account that is not listening', async () => {
    const watching = await traderWithPosition();
    const other = await traderWithPosition();
    const index = build();

    const exposed = await index.exposedTo('XAUUSD', new Set([watching.accountId]), Date.now());
    expect(exposed).toEqual([watching.accountId]);
    expect(exposed).not.toContain(other.accountId);
  });

  /**
   * The reason the index subscribes to domain events at all. A position opened
   * after the account was first indexed must be visible on the *next tick*, not
   * on the next rebuild — thirty seconds of a frozen P&L is thirty seconds of a
   * terminal that looks broken.
   */
  it('picks up a new position immediately, not at the next rebuild', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    const index = build();
    const listening = new Set([trader.accountId]);

    // Indexed while holding nothing.
    expect(await index.exposedTo('XAUUSD', listening, Date.now())).toEqual([]);

    await events.publish(DomainEvent.POSITION_OPENED, trader.accountId, { symbol: 'XAUUSD' });

    expect(await index.exposedTo('XAUUSD', listening, Date.now())).toEqual([trader.accountId]);
  });

  /**
   * Over-including is the safe direction and is *deliberate*, so it is pinned
   * rather than left as an accident somebody later "fixes" into a race.
   */
  it('keeps reporting a closed position until the rebuild, on purpose', async () => {
    const trader = await traderWithPosition();
    const index = build(30_000);
    const listening = new Set([trader.accountId]);
    const now = Date.now();

    expect(await index.exposedTo('XAUUSD', listening, now)).toEqual([trader.accountId]);

    await stack.positions.close(trader.userId, trader.positionId, null);

    // Still listed: a wasted valuation, never a missed one.
    expect(await index.exposedTo('XAUUSD', listening, now + 1_000)).toEqual([trader.accountId]);
  });

  it('drops it once the rebuild interval has passed', async () => {
    const trader = await traderWithPosition();
    const index = build(1_000);
    const listening = new Set([trader.accountId]);
    const now = Date.now();

    await index.exposedTo('XAUUSD', listening, now);
    await stack.positions.close(trader.userId, trader.positionId, null);

    expect(await index.exposedTo('XAUUSD', listening, now + 1_500)).toEqual([]);
  });

  /**
   * The self-healing property. A domain event that never arrived — a dropped
   * Redis message, a position opened by a different process, a manual database
   * change — must not leave the index wrong for the life of the process.
   */
  it('heals drift it was never told about', async () => {
    const trader = await createAccount(prisma, { balance: '100000' });
    const index = build(1_000);
    const listening = new Set([trader.accountId]);
    const now = Date.now();

    await index.exposedTo('XAUUSD', listening, now);

    // Opened without any event reaching the index.
    const silent = new EventsService(fakeRedis);
    const quiet = await buildTradingStack(prisma);
    await quiet.publishQuote('XAUUSD', BID, ASK);
    void silent;
    await quiet.orders.openPosition(trader.userId, {
      accountId: trader.accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '1.00',
    });

    expect(await index.exposedTo('XAUUSD', listening, now + 1_500)).toEqual([trader.accountId]);
  });

  it('forgets an account nobody is watching', async () => {
    const trader = await traderWithPosition();
    const index = build();

    await index.exposedTo('XAUUSD', new Set([trader.accountId]), Date.now());
    expect(index.size.accounts).toBe(1);

    index.forget(trader.accountId);
    expect(index.size).toEqual({ symbols: 0, accounts: 0 });
  });

  /**
   * The point of the change. One query when an account first appears, one per
   * rebuild interval — and none at all in between, however many ticks arrive.
   */
  it('does not query the database on every call', async () => {
    const trader = await traderWithPosition();
    const db = watched();
    const index = new ExposureIndex(db.client, events, 30_000);
    const listening = new Set([trader.accountId]);
    const now = Date.now();

    // One read to learn about an account it has never seen.
    await index.exposedTo('XAUUSD', listening, now);
    expect(db.calls).toBe(1);

    // Fifty ticks inside the refresh interval, and not one more read. This is
    // the whole change: it used to be fifty queries.
    for (let tick = 0; tick < 50; tick += 1) {
      await index.exposedTo('XAUUSD', listening, now + tick * 10);
    }
    expect(db.calls).toBe(1);
  });

  it('serves the previous index when a rebuild fails, rather than nothing', async () => {
    const trader = await traderWithPosition();
    const db = watched();
    const index = new ExposureIndex(db.client, events, 1_000);
    const listening = new Set([trader.accountId]);
    const now = Date.now();

    await index.exposedTo('XAUUSD', listening, now);
    db.failOnce();

    // Stale in the safe direction beats empty: the account keeps being valued
    // through a database blip rather than having its P&L freeze.
    expect(await index.exposedTo('XAUUSD', listening, now + 1_500)).toEqual([trader.accountId]);
  });
});
