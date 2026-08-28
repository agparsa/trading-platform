import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AuditService } from '../../src/common/audit/audit.service';
import { IntegrityService } from '../../src/integrity/integrity.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedTradingSymbols,
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
    await prisma.integritySignalEvent.deleteMany();
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
});
