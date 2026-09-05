import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import {
  AdminInstrumentsService,
  normaliseWindows,
  assertTimezone,
} from '../../src/admin/instruments.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { SymbolsService } from '../../src/symbols/symbols.service';
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

/**
 * When an instrument trades.
 *
 * The model has existed since the beginning and nothing could edit it: the
 * only writer in the repository was the seed. So a firm that needed Friday to
 * close an hour early needed a database console.
 *
 * What these tests are about is that editing it is safe — the week is replaced
 * whole rather than window by window, a week that describes itself twice is
 * refused rather than merged, and the change reaches the engine that checks it
 * before every order rather than waiting for a restart.
 */
suite('Market sessions (integration)', () => {
  let prisma: PrismaClient;
  let stack: TradingStack;
  let instruments: AdminInstrumentsService;
  let symbols: SymbolsService;
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
    await stack.publishQuote('XAUUSD', '4583.58', '4583.72');

    const prismaService = prisma as unknown as PrismaService;
    symbols = stack.symbols;
    instruments = new AdminInstrumentsService(
      prismaService,
      new AuditService(prismaService),
      symbols,
    );
    actorId = (
      await prisma.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email: `ops-${Date.now()}@test.local`,
          passwordHash: 'not-a-real-hash',
          displayName: 'Ops',
          role: 'ADMIN',
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

  const REASON = 'the venue moved its Friday close';

  it('reads the week as it is stored, in the session’s own timezone', async () => {
    const view = await instruments.sessions('XAUUSD');
    expect(view.code).toBe('XAUUSD');
    expect(view.timezone).toBe('UTC');
    // The harness seeds all seven days open.
    expect(view.windows).toHaveLength(7);
    expect(view.windows[0]).toEqual({ dayOfWeek: 0, openMinute: 0, closeMinute: 1440 });
  });

  it('replaces the week whole, and the change reaches the engine at once', async () => {
    const saved = await instruments.setSessions(
      actorId,
      'XAUUSD',
      {
        timezone: 'Europe/London',
        // Monday to Thursday all day; Friday closes at 21:00.
        windows: [
          { dayOfWeek: 1, openMinute: 0, closeMinute: 1440 },
          { dayOfWeek: 2, openMinute: 0, closeMinute: 1440 },
          { dayOfWeek: 3, openMinute: 0, closeMinute: 1440 },
          { dayOfWeek: 4, openMinute: 0, closeMinute: 1440 },
          { dayOfWeek: 5, openMinute: 0, closeMinute: 1260 },
        ],
      },
      REASON,
    );
    expect(saved.timezone).toBe('Europe/London');
    expect(saved.windows).toHaveLength(5);

    // The weekend is gone, not merely overwritten on the days that were sent.
    const rows = await prisma.marketSession.findMany({ orderBy: { dayOfWeek: 'asc' } });
    expect(rows.map((row) => row.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.every((row) => row.timezone === 'Europe/London')).toBe(true);

    // And the cache the order path reads was refreshed, rather than waiting
    // for a restart — the shape of "it did not apply" that gets blamed on the
    // market.
    const instrument = symbols.require('XAUUSD');
    expect(instrument.session.timezone).toBe('Europe/London');
    expect(instrument.session.windows).toHaveLength(5);
  });

  it('a closed day actually stops an order, through the ordinary path', async () => {
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    // A week with exactly one open day. Whichever day it is now, at most one
    // of these two assertions is about an open market — so both are made.
    const today = new Date().getUTCDay();
    const other = (today + 3) % 7;
    await instruments.setSessions(
      actorId,
      'XAUUSD',
      { timezone: 'UTC', windows: [{ dayOfWeek: other, openMinute: 0, closeMinute: 1440 }] },
      REASON,
    );

    expect(
      await codeOf(() =>
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.10',
        }),
      ),
    ).toBe(TradingErrorCode.MARKET_CLOSED);

    // Re-open today and the same order goes through.
    await instruments.setSessions(
      actorId,
      'XAUUSD',
      { timezone: 'UTC', windows: [{ dayOfWeek: today, openMinute: 0, closeMinute: 1440 }] },
      REASON,
    );
    const result = await stack.orders.openPosition(userId, {
      accountId,
      symbol: 'XAUUSD',
      side: 'BUY',
      volume: '0.10',
    });
    expect(result.status).toBe('FILLED');
  });

  it('an empty week is a market that never opens, and is allowed to be said', async () => {
    await instruments.setSessions(actorId, 'XAUUSD', { timezone: 'UTC', windows: [] }, REASON);
    expect((await instruments.sessions('XAUUSD')).windows).toEqual([]);
    const { userId, accountId } = await createAccount(prisma, { balance: '100000' });
    expect(
      await codeOf(() =>
        stack.orders.openPosition(userId, {
          accountId,
          symbol: 'XAUUSD',
          side: 'BUY',
          volume: '0.10',
        }),
      ),
    ).toBe(TradingErrorCode.MARKET_CLOSED);
  });

  it('records who changed the week and what it was before', async () => {
    await instruments.setSessions(
      actorId,
      'XAUUSD',
      { timezone: 'UTC', windows: [{ dayOfWeek: 1, openMinute: 60, closeMinute: 120 }] },
      REASON,
    );
    const trail = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'instrument.sessions_changed' },
    });
    expect(trail.actorId).toBe(actorId);
    expect(JSON.stringify(trail.before)).toContain('1440');
    expect(JSON.stringify(trail.after)).toContain(REASON);
  });

  it('refuses a change with no reason worth recording', async () => {
    expect(
      await codeOf(() =>
        instruments.setSessions(actorId, 'XAUUSD', { timezone: 'UTC', windows: [] }, 'no'),
      ),
    ).toBe(TradingErrorCode.VALIDATION_FAILED);
    // And nothing changed.
    expect((await instruments.sessions('XAUUSD')).windows).toHaveLength(7);
  });

  it('is a platform act: a broker cannot set when the venue trades', async () => {
    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      expect(
        await codeOf(() =>
          instruments.setSessions(actorId, 'XAUUSD', { timezone: 'UTC', windows: [] }, REASON),
        ),
      ).toBe(TradingErrorCode.FORBIDDEN);
    });
    expect((await instruments.sessions('XAUUSD')).windows).toHaveLength(7);
  });

  it('refuses an instrument it does not have', async () => {
    expect(await codeOf(() => instruments.sessions('NOPE'))).toBe(
      TradingErrorCode.RESOURCE_NOT_FOUND,
    );
  });
});

describe('trading-week validation', () => {
  const window = (dayOfWeek: number, openMinute: number, closeMinute: number) => ({
    dayOfWeek,
    openMinute,
    closeMinute,
  });

  it('sorts the week, so two descriptions of the same week are one row order', () => {
    expect(
      normaliseWindows([window(3, 60, 120), window(1, 600, 700), window(1, 0, 60)]),
    ).toEqual([window(1, 0, 60), window(1, 600, 700), window(3, 60, 120)]);
  });

  it('refuses a window that closes before it opens, and says how to cross midnight', () => {
    const error = (() => {
      try {
        normaliseWindows([window(1, 1380, 60)]);
        return null;
      } catch (e) {
        return e as DomainError;
      }
    })();
    expect(error?.code).toBe(TradingErrorCode.VALIDATION_FAILED);
    expect(error?.message).toContain('two windows');
  });

  it('refuses two windows on one day that overlap, rather than merging them', () => {
    // Merging would hide which of two disagreeing descriptions was meant, and
    // make "why was it open at 3am" unanswerable from the row.
    expect(() => normaliseWindows([window(1, 0, 600), window(1, 500, 700)])).toThrow(/overlap/);
    // Touching is not overlapping: 0–600 and 600–700 is one continuous window
    // described in two parts, which is legitimate.
    expect(normaliseWindows([window(1, 0, 600), window(1, 600, 700)])).toHaveLength(2);
  });

  it('refuses a day or a minute outside the week', () => {
    expect(() => normaliseWindows([window(7, 0, 60)])).toThrow(/Sunday/);
    expect(() => normaliseWindows([window(-1, 0, 60)])).toThrow(/Sunday/);
    expect(() => normaliseWindows([window(1, 0, 1441)])).toThrow(/minutes/);
    expect(() => normaliseWindows([window(1, 1.5, 60)])).toThrow(/minutes/);
  });

  it('checks a timezone against the system’s own database, not a list somebody typed', () => {
    expect(() => assertTimezone('Europe/London')).not.toThrow();
    expect(() => assertTimezone('UTC')).not.toThrow();
    expect(() => assertTimezone('Mars/Olympus')).toThrow(/not a timezone/);
    expect(() => assertTimezone('GMT+2')).toThrow(/not a timezone/);
  });
});
