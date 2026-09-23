import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { withTenant } from '@tp/tenancy';
import { ChartsService } from '../../src/charts/charts.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTenant,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Chart arrangements, kept.
 *
 * The chart's own state was client-local: a reload lost the resolution, and
 * nothing a trader arranged survived closing the tab. What these tests are
 * about is the three decisions that shape the storage — the arrangement is a
 * blob this platform never parses, "which chart do I get" cannot depend on row
 * order, and drawings belong to the instrument rather than to a layout.
 */
suite('Chart persistence (integration)', () => {
  let prisma: PrismaClient;
  let charts: ChartsService;
  let alice: { userId: string; accountId: string };
  let bob: { userId: string; accountId: string };

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    charts = new ChartsService(prisma as unknown as PrismaService);
    alice = await createAccount(prisma, { email: `a-${Date.now()}@test.local` });
    bob = await createAccount(prisma, { email: `b-${Date.now()}@test.local` });
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

  const layout = (over: Partial<Parameters<ChartsService['saveLayout']>[1]> = {}) => ({
    name: 'Gold intraday',
    symbol: 'xauusd',
    resolution: '15',
    accountId: null,
    content: { panes: [{ studies: ['ma'] }], viewport: { from: 1, to: 2 } },
    ...over,
  });

  it('keeps the arrangement exactly as it was given, and never reshapes it', async () => {
    const content = {
      // Deliberately awkward: a nested array, a null, a number that is not an
      // integer, and a key this platform has never heard of.
      studies: [{ id: 'RSI@tv-basicstudies', inputs: [14, null, 1.5] }],
      somethingTheRendererInvented: { deep: { deeper: ['x'] } },
      viewport: { from: 1_700_000_000, to: 1_700_003_600 },
    };
    await charts.saveLayout(alice.userId, layout({ content }));

    const [summary] = await charts.layouts(alice.userId);
    const saved = await charts.layout(alice.userId, summary?.id as string);
    expect(saved.content).toEqual(content);
    // And the columns the platform *does* keep are normalised, so a list can
    // be shown without parsing the blob.
    expect(saved.symbol).toBe('XAUUSD');
    expect(saved.resolution).toBe('15');
  });

  it('saving over a name replaces it, because that is what save means', async () => {
    await charts.saveLayout(alice.userId, layout({ content: { v: 1 } }));
    await charts.saveLayout(alice.userId, layout({ content: { v: 2 }, resolution: '60' }));

    const list = await charts.layouts(alice.userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.resolution).toBe('60');
    const saved = await charts.layout(alice.userId, list[0]?.id as string);
    expect(saved.content).toEqual({ v: 2 });
  });

  it('answers null for a person who has saved nothing, rather than inventing one', async () => {
    expect(await charts.defaultLayout(alice.userId, null)).toBe(null);
  });

  /**
   * "Which chart do I get when I open the terminal" must have one answer. The
   * database enforces it, so a future writer cannot leave two.
   */
  it('keeps exactly one default, and moving it moves it', async () => {
    await charts.saveLayout(alice.userId, layout({ name: 'First', isDefault: true }));
    await charts.saveLayout(alice.userId, layout({ name: 'Second', isDefault: true }));

    const list = await charts.layouts(alice.userId);
    expect(list.filter((one) => one.isDefault).map((one) => one.name)).toEqual(['Second']);
    expect((await charts.defaultLayout(alice.userId, null))?.name).toBe('Second');

    // And the database refuses a second one written around the service.
    const first = list.find((one) => one.name === 'First');
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE chart_layouts SET is_default = true WHERE id = $1`,
        first?.id,
      ),
    ).rejects.toThrow();
  });

  it('keeps a default per account, so two accounts open two charts', async () => {
    await charts.saveLayout(
      alice.userId,
      layout({ name: 'House', accountId: alice.accountId, isDefault: true }),
    );
    await charts.saveLayout(alice.userId, layout({ name: 'Anywhere', isDefault: true }));

    expect((await charts.defaultLayout(alice.userId, alice.accountId))?.name).toBe('House');
    expect((await charts.defaultLayout(alice.userId, null))?.name).toBe('Anywhere');
    // The list can be narrowed to one account.
    expect(await charts.layouts(alice.userId, alice.accountId)).toHaveLength(1);
    expect(await charts.layouts(alice.userId)).toHaveLength(2);
  });

  it('refuses an arrangement too large to be one, naming the size', async () => {
    const huge = { blob: 'x'.repeat(300 * 1024) };
    const error = await charts
      .saveLayout(alice.userId, layout({ content: huge }))
      .then(() => null)
      .catch((e: unknown) => e as DomainError);
    expect(error?.code).toBe(TradingErrorCode.VALIDATION_FAILED);
    expect(error?.message).toMatch(/KB/);
    expect(await charts.layouts(alice.userId)).toEqual([]);
  });

  it('is one person’s: another trader sees none of it and cannot read one by id', async () => {
    await charts.saveLayout(alice.userId, layout());
    const [mine] = await charts.layouts(alice.userId);

    expect(await charts.layouts(bob.userId)).toEqual([]);
    expect(await codeOf(() => charts.layout(bob.userId, mine?.id as string))).toBe(
      TradingErrorCode.RESOURCE_NOT_FOUND,
    );
    expect(await codeOf(() => charts.deleteLayout(bob.userId, mine?.id as string))).toBe(
      TradingErrorCode.RESOURCE_NOT_FOUND,
    );
    // Still there: the refused delete refused.
    expect(await charts.layouts(alice.userId)).toHaveLength(1);
  });

  it('is one firm’s too', async () => {
    await charts.saveLayout(alice.userId, layout());
    const otherId = await createTenant(prisma, 'other-firm');
    await withTenant({ tenantId: otherId, slug: 'other-firm', kind: 'BROKER' }, async () => {
      expect(await charts.layouts(alice.userId)).toEqual([]);
    });
  });

  it('deletes a layout it holds and refuses one it does not', async () => {
    await charts.saveLayout(alice.userId, layout());
    const [one] = await charts.layouts(alice.userId);
    await charts.deleteLayout(alice.userId, one?.id as string);
    expect(await charts.layouts(alice.userId)).toEqual([]);
    expect(
      await codeOf(() => charts.deleteLayout(alice.userId, '00000000-0000-4000-8000-000000000001')),
    ).toBe(TradingErrorCode.RESOURCE_NOT_FOUND);
  });

  describe('study templates', () => {
    it('are saved by name, independent of any instrument, and replaced on save', async () => {
      await charts.saveTemplate(alice.userId, 'My studies', { studies: ['ma', 'rsi'] });
      await charts.saveTemplate(alice.userId, 'My studies', { studies: ['ma'] });

      const list = await charts.templates(alice.userId);
      expect(list).toHaveLength(1);
      expect((await charts.template(alice.userId, 'My studies')).content).toEqual({
        studies: ['ma'],
      });
    });

    it('are one person’s, and a missing one is a refusal rather than an empty set', async () => {
      await charts.saveTemplate(alice.userId, 'Mine', { studies: [] });
      expect(await charts.templates(bob.userId)).toEqual([]);
      expect(await codeOf(() => charts.template(bob.userId, 'Mine'))).toBe(
        TradingErrorCode.RESOURCE_NOT_FOUND,
      );
    });

    it('refuses one too large, and deletes one it holds', async () => {
      expect(
        await codeOf(() =>
          charts.saveTemplate(alice.userId, 'Huge', { blob: 'x'.repeat(300 * 1024) }),
        ),
      ).toBe(TradingErrorCode.VALIDATION_FAILED);
      await charts.saveTemplate(alice.userId, 'Small', {});
      await charts.deleteTemplate(alice.userId, 'Small');
      expect(await charts.templates(alice.userId)).toEqual([]);
    });
  });

  describe('drawings', () => {
    /**
     * Per instrument, not per layout. A trendline drawn on gold is about gold,
     * and a trader who opens a different layout expects their lines to still
     * be there.
     */
    it('belong to the instrument and survive a change of layout', async () => {
      await charts.saveDrawings(alice.userId, 'XAUUSD', { lines: [{ id: 'a', price: '4000' }] });
      await charts.saveLayout(alice.userId, layout({ name: 'One' }));
      await charts.saveLayout(alice.userId, layout({ name: 'Two' }));

      const drawn = await charts.drawings(alice.userId, 'xauusd');
      expect(drawn.symbol).toBe('XAUUSD');
      expect(drawn.content).toEqual({ lines: [{ id: 'a', price: '4000' }] });
    });

    it('answer with nothing drawn rather than a refusal for a clean instrument', async () => {
      const drawn = await charts.drawings(alice.userId, 'EURUSD');
      expect(drawn.content).toEqual({});
      expect(drawn.symbol).toBe('EURUSD');
    });

    it('replace wholesale, because that is what the renderer hands over', async () => {
      await charts.saveDrawings(alice.userId, 'XAUUSD', { lines: [1, 2, 3] });
      await charts.saveDrawings(alice.userId, 'XAUUSD', { lines: [] });
      expect((await charts.drawings(alice.userId, 'XAUUSD')).content).toEqual({ lines: [] });
      expect(await prisma.userDrawing.count({ where: { userId: alice.userId } })).toBe(1);
    });

    it('are one person’s: another trader’s instrument is clean', async () => {
      await charts.saveDrawings(alice.userId, 'XAUUSD', { lines: [1] });
      expect((await charts.drawings(bob.userId, 'XAUUSD')).content).toEqual({});
    });
  });
});
