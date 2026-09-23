import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AuditService } from '../../src/common/audit/audit.service';
import { IntegrityService } from '../../src/integrity/integrity.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { toDecimal } from '@tp/financial-core';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
  DEFAULT_TENANT_ID,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * The integrity engine against a real database.
 *
 * The pure detectors are tested in `@tp/integrity-core`, where a fixture can be
 * built to sit exactly on a threshold. What can only be checked here is what the
 * engine *does* with what it noticed: that a recurring pattern stays one signal
 * rather than a thousand, that evidence is never overwritten, and that an
 * operator's judgement is not silently overruled the next time the pattern
 * repeats.
 */
suite('Integrity engine (integration)', () => {
  let prisma: PrismaClient;
  let integrity: IntegrityService;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    integrity = new IntegrityService(
      prisma as unknown as PrismaService,
      new AuditService(prisma as unknown as PrismaService),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.integritySignal.deleteMany();
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedTradingSymbols(prisma);
  });

  const NOW = Date.now();

  /** `count` orders arriving inside `spanMs`, which is what a burst looks like. */
  async function placeOrders(
    accountId: string,
    count: number,
    spanMs: number,
    overrides: Record<string, unknown> = {},
  ) {
    const symbol = await prisma.symbol.findFirstOrThrow({ where: { code: 'XAUUSD' } });
    const step = count > 1 ? spanMs / (count - 1) : 0;
    for (let i = 0; i < count; i += 1) {
      await prisma.order.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          accountId,
          symbolId: symbol.id,
          side: 'BUY',
          type: 'MARKET',
          status: 'FILLED',
          timeInForce: 'IOC',
          volume: '1',
          filledVolume: '1',
          createdAt: new Date(NOW - spanMs + i * step),
          ...overrides,
        },
      });
    }
  }

  /**
   * Amendments and cancellations on one resting order (§46).
   *
   * Written straight into `OrderEvent`, which is where the platform already
   * records them — the point of this detector is that it needed no new data
   * collection, and a test that invented a new table would not be testing that.
   */
  async function amend(accountId: string, count: number, spanMs: number) {
    const symbol = await prisma.symbol.findFirstOrThrow({ where: { code: 'XAUUSD' } });
    const order = await prisma.order.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        accountId,
        symbolId: symbol.id,
        side: 'BUY',
        type: 'LIMIT',
        status: 'ACCEPTED',
        timeInForce: 'GTC',
        volume: '1',
        filledVolume: '0',
        price: '4500',
        createdAt: new Date(NOW - spanMs - 1_000),
      },
    });
    const step = count > 1 ? spanMs / (count - 1) : 0;
    for (let i = 0; i < count; i += 1) {
      await prisma.orderEvent.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          orderId: order.id,
          type: 'MODIFIED',
          toStatus: 'ACCEPTED',
          createdAt: new Date(NOW - spanMs + i * step),
        },
      });
    }
    return order.id;
  }

  it('notices one order amended over and over, from the events it already keeps', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    const orderId = await amend(accountId, 12, 20_000);

    const signals = await integrity.scanAccount(accountId, NOW);
    expect(signals.map((s) => s.code)).toContain('RAPID_CANCEL_REPLACE');

    const stored = await prisma.integritySignal.findFirstOrThrow({
      where: { accountId, code: 'RAPID_CANCEL_REPLACE' },
    });
    const raised = await prisma.integritySignalEvent.findFirstOrThrow({
      where: { signalId: stored.id, type: 'RAISED' },
    });
    // The order is named, so a reviewer can go and look at it.
    expect(JSON.stringify(raised.evidence)).toContain(orderId);
  });

  /**
   * A busy desk working many orders is not one order being worked. Summing
   * across the account would report every busy morning as an incident, until
   * operators learned to dismiss the code.
   */
  it('does not fire when the amendments are spread across many orders', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    for (let i = 0; i < 10; i += 1) await amend(accountId, 2, 20_000);

    const signals = await integrity.scanAccount(accountId, NOW);
    expect(signals.map((s) => s.code)).not.toContain('RAPID_CANCEL_REPLACE');
  });

  /**
   * A request that was refused is not churn on the book.
   *
   * `MODIFY_REQUESTED` without a following `MODIFIED` means the amendment
   * bounced off a validation rule. Counting it would report a trader whose
   * client keeps sending something the engine will never accept as though they
   * were working the order — a support problem dressed up as an integrity one.
   */
  it('does not count amendments the engine refused', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    const symbol = await prisma.symbol.findFirstOrThrow({ where: { code: 'XAUUSD' } });
    const order = await prisma.order.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        accountId,
        symbolId: symbol.id,
        side: 'BUY',
        type: 'LIMIT',
        status: 'ACCEPTED',
        timeInForce: 'GTC',
        volume: '1',
        filledVolume: '0',
        price: '4500',
        createdAt: new Date(NOW - 30_000),
      },
    });
    for (let i = 0; i < 20; i += 1) {
      await prisma.orderEvent.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          orderId: order.id,
          type: 'MODIFY_REQUESTED',
          toStatus: 'ACCEPTED',
          createdAt: new Date(NOW - 20_000 + i * 500),
        },
      });
    }

    const signals = await integrity.scanAccount(accountId, NOW);
    expect(signals.map((s) => s.code)).not.toContain('RAPID_CANCEL_REPLACE');
  });

  it('says nothing about an account that has barely traded', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    await placeOrders(accountId, 3, 600_000);
    expect(await integrity.scanAccount(accountId, NOW)).toEqual([]);
    expect(await prisma.integritySignal.count()).toBe(0);
  });

  it('raises a signal, with its evidence, for a burst of orders', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    await placeOrders(accountId, 20, 3_000);

    const signals = await integrity.scanAccount(accountId, NOW);
    expect(signals.map((s) => s.code)).toContain('ORDER_BURST');

    const stored = await prisma.integritySignal.findFirstOrThrow({
      where: { accountId, code: 'ORDER_BURST' },
    });
    expect(stored.status).toBe('OPEN');
    expect(stored.occurrences).toBe(1);

    const raised = await prisma.integritySignalEvent.findFirstOrThrow({
      where: { signalId: stored.id, type: 'RAISED' },
    });
    // A signal a person cannot check is a signal they have to trust.
    expect(raised.evidence).not.toBeNull();
    expect(JSON.stringify(raised.evidence)).toContain('orders');
  });

  /**
   * A pattern that keeps recurring is the *same* signal seen again. A thousand
   * duplicate rows would hide the one fact a reviewer needs — how persistent
   * this is — behind a thousand copies of it.
   */
  it('counts a recurring pattern rather than queueing it again', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    await placeOrders(accountId, 20, 3_000);

    await integrity.scanAccount(accountId, NOW);
    await integrity.scanAccount(accountId, NOW);
    await integrity.scanAccount(accountId, NOW);

    const signals = await prisma.integritySignal.findMany({
      where: { accountId, code: 'ORDER_BURST' },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.occurrences).toBe(3);

    // Every sighting is still individually recorded.
    const events = await prisma.integritySignalEvent.findMany({
      where: { signalId: signals[0]?.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual(['RAISED', 'RECURRED', 'RECURRED']);
  });

  /**
   * The rule that keeps a review queue usable. Re-opening something an operator
   * has already dismissed, every time the pattern repeats, overrules their
   * judgement with a threshold — and trains them to stop looking.
   */
  it('does not reopen a signal an operator has dismissed', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    const { userId: operatorId } = await createAccount(prisma, {
      email: `operator-${Date.now()}@test.local`,
    });
    await placeOrders(accountId, 20, 3_000);
    await integrity.scanAccount(accountId, NOW);

    const signal = await prisma.integritySignal.findFirstOrThrow({ where: { accountId } });
    await integrity.setStatus(
      operatorId,
      signal.id,
      'FALSE_POSITIVE',
      'A known market-making bot.',
    );

    await integrity.scanAccount(accountId, NOW);

    const after = await prisma.integritySignal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(after.status).toBe('FALSE_POSITIVE');
    // The recurrence is still recorded — it is dismissed, not unseen.
    expect(after.occurrences).toBe(2);
  });

  /**
   * Evidence that can be overwritten is evidence that cannot be relied on. "What
   * did this look like when it was raised" has to stay answerable after somebody
   * has reviewed and closed it.
   */
  it('never overwrites the evidence a signal was raised on', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    const { userId: operatorId } = await createAccount(prisma, {
      email: `reviewer-${Date.now()}@test.local`,
    });
    await placeOrders(accountId, 20, 3_000);
    await integrity.scanAccount(accountId, NOW);

    const signal = await prisma.integritySignal.findFirstOrThrow({ where: { accountId } });
    const originalEvidence = JSON.stringify(
      (
        await prisma.integritySignalEvent.findFirstOrThrow({
          where: { signalId: signal.id, type: 'RAISED' },
        })
      ).evidence,
    );

    await integrity.setStatus(operatorId, signal.id, 'INVESTIGATING');
    await integrity.setStatus(operatorId, signal.id, 'RESOLVED', 'Contacted the customer.');
    await integrity.scanAccount(accountId, NOW);

    const stillThere = await prisma.integritySignalEvent.findFirstOrThrow({
      where: { signalId: signal.id, type: 'RAISED' },
    });
    expect(JSON.stringify(stillThere.evidence)).toBe(originalEvidence);

    const detail = await integrity.detail(signal.id);
    expect(detail.events.map((e) => e.type)).toEqual([
      'RAISED',
      'STATUS_CHANGED',
      'STATUS_CHANGED',
      'RECURRED',
    ]);
  });

  it('records who reviewed a signal, and audits it', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    const { userId: operatorId } = await createAccount(prisma, {
      email: `auditor-${Date.now()}@test.local`,
    });
    await placeOrders(accountId, 20, 3_000);
    await integrity.scanAccount(accountId, NOW);

    const signal = await prisma.integritySignal.findFirstOrThrow({ where: { accountId } });
    await integrity.setStatus(operatorId, signal.id, 'ACKNOWLEDGED');

    const reviewed = await prisma.integritySignal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(reviewed.reviewedByUserId).toBe(operatorId);
    expect(reviewed.reviewedAt).not.toBeNull();

    const audited = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'integrity.signal_reviewed', resourceId: signal.id },
    });
    expect(audited.actorId).toBe(operatorId);
  });

  /**
   * A pattern in trading activity is never, on its own, the most serious thing
   * this platform can say. `CRITICAL` belongs to a ledger that does not add up.
   */
  it('never records a signal as critical', async () => {
    const { accountId } = await createAccount(prisma, { balance: '100000' });
    await placeOrders(accountId, 120, 1_000, {
      price: '4000.00',
      type: 'LIMIT',
      status: 'PENDING',
    });
    await integrity.scanAccount(accountId, NOW);

    const signals = await prisma.integritySignal.findMany({ where: { accountId } });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.severity !== 'CRITICAL')).toBe(true);
  });

  it('scans only accounts that have traded recently', async () => {
    const busy = await createAccount(prisma, { balance: '100000' });
    await createAccount(prisma, { balance: '100000', email: `dormant-${Date.now()}@test.local` });
    await placeOrders(busy.accountId, 20, 3_000);

    const result = await integrity.scanAll(NOW);
    expect(result.scanned).toBe(1);
    expect(result.raised).toBeGreaterThan(0);
  });

  it('refuses to review a signal that does not exist', async () => {
    await expect(
      integrity.setStatus(
        '00000000-0000-4000-8000-000000000000',
        '00000000-0000-4000-8000-000000000001',
        'RESOLVED',
      ),
    ).rejects.toThrow();
  });

  /**
   * Exposure arithmetic, which is the input every concentration judgement is
   * made from.
   *
   * `detectConcentration` is scrupulous — `toDecimal`, `.plus`, `.div`, `.mul`
   * on every line. The loader that fed it was not: it multiplied volume by
   * contract size by entry price with `Number`, accumulated with `+`, and wrote
   * the running total back through `toFixed(2)` on each position. A careful
   * calculation performed on an input that had already lost precision, which is
   * the least visible way to be wrong.
   *
   * The values below are ordinary. 0.41 lots of an instrument at 975.635 with a
   * contract size of 100 is 40001.04; the float path returned 40001.03, because
   * the double sits a hair under the true value and `toFixed` rounds it down.
   * A cent per position, compounding through the running total, on the numbers
   * a fraud signal is raised from.
   */
  describe('exposure is computed in decimal', () => {
    const VOLUME = '0.41';
    const PRICE = '975.635';
    /** 0.41 x 100 x 975.635, exactly. */
    const EXACT_EACH = '40001.04';
    const EXACT_TOTAL = '80002.08';

    /**
     * A second instrument small enough that the concentration is still in the
     * first one. The seeded USDJPY has a contract size of 100,000, so a single
     * minimum-volume position in it is larger than the whole book being tested.
     */
    async function seedTinySymbol() {
      const symbol = await prisma.symbol.upsert({
        where: { code: 'TINY' },
        create: {
          code: 'TINY',
          description: 'A rounding error',
          category: 'Test',
          quoteCurrency: 'USD',
        },
        update: {},
      });
      await prisma.symbolSpec.upsert({
        where: { symbolId: symbol.id },
        create: {
          symbolId: symbol.id,
          contractSize: '1',
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
    }

    async function openPosition(accountId: string, code: string, volume: string, price: string) {
      const symbol = await prisma.symbol.findFirstOrThrow({ where: { code } });
      await prisma.position.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          accountId,
          symbolId: symbol.id,
          side: 'BUY',
          status: 'OPEN',
          volume,
          initialVolume: volume,
          entryPrice: price,
          margin: '1',
        },
      });
    }

    it('reports a notional the float path gets wrong by a cent', async () => {
      const { accountId } = await createAccount(prisma, { balance: '1000000' });
      // Two positions in the concentrated instrument, and a small one
      // elsewhere so that "concentration" means something — one instrument is
      // trivially all of itself, and the detector says so.
      await openPosition(accountId, 'XAUUSD', VOLUME, PRICE);
      await openPosition(accountId, 'XAUUSD', VOLUME, PRICE);
      await seedTinySymbol();
      await openPosition(accountId, 'TINY', '0.01', '1');

      const signals = await integrity.scanAccount(accountId, NOW);
      const concentration = signals.find((signal) => signal.code === 'CONCENTRATION');
      expect(concentration, 'the book is 98% in one instrument').toBeDefined();

      expect(
        concentration?.evidence['notional'],
        `the float path returned 40001.03 for each leg, so 80002.06 for the pair`,
      ).toBe(EXACT_TOTAL);

      // And the single-position figure, so a regression cannot pass by having
      // two errors cancel.
      expect(toDecimal(EXACT_TOTAL).div(2).toFixed(2)).toBe(EXACT_EACH);
    });
  });
});
