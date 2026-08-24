import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { SwapAccrualService } from '../../src/jobs/swap-accrual.service';
import { ReconciliationService } from '../../src/jobs/reconciliation.service';
import { MaintenanceService } from '../../src/jobs/maintenance.service';
import type { PrismaService } from '../../src/prisma.service';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedSymbols,
} from './harness';

const suite = hasTestDatabase ? describe : describe.skip;

/**
 * Services are constructed by hand — Vitest's esbuild transform does not emit
 * decorator metadata, so Nest's container cannot resolve them. See the note in
 * the API's auth tests.
 */
function buildConfig(overrides: Record<string, unknown> = {}): ConfigService {
  return new ConfigService({
    TRADING_SERVER_TIMEZONE: 'UTC',
    SWAP_TRIPLE_DAY: 3,
    ...overrides,
  } as never);
}

suite('Worker jobs (integration)', () => {
  let prisma: PrismaClient;
  let prismaService: PrismaService;

  beforeAll(async () => {
    prisma = createTestClient();
    await prisma.$connect();
    prismaService = prisma as unknown as PrismaService;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.marketSession.deleteMany();
    await prisma.symbolSpec.deleteMany();
    await prisma.symbol.deleteMany();
    await seedSymbols(prisma);
  });

  /** Opens a position directly: these jobs do not care how it was created. */
  const openPosition = async (side: 'BUY' | 'SELL', volume: string, accountBalance = '100000') => {
    const { userId, accountId } = await createAccount(prisma, { balance: accountBalance });
    const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
    const position = await prisma.position.create({
      data: {
        accountId,
        symbolId: symbol.id,
        side,
        status: 'OPEN',
        volume,
        initialVolume: volume,
        entryPrice: '4583.72',
        margin: '4583.72',
      },
    });
    return { userId, accountId, positionId: position.id };
  };

  describe('swap accrual', () => {
    const service = (overrides: Record<string, unknown> = {}) =>
      new SwapAccrualService(prismaService, buildConfig(overrides) as never);

    /** XAUUSD long swap is −12.50 per lot per night in the seeded spec. */
    it('debits a long one night of financing and posts it to the ledger', async () => {
      const { accountId, positionId } = await openPosition('BUY', '1.00');

      // A Monday, so one night.
      const summary = await service().accrue(new Date('2026-08-24T00:00:00Z'));
      expect(summary.nights).toBe(1);
      expect(summary.accrued).toBe(1);

      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'SWAP' },
      });
      expect(entry.amount.toString()).toBe('-12.5');
      expect(Money.of(entry.balanceAfter.toString(), 'USD').toString()).toBe('99987.50');

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('99987.50');

      // The position tracks what it has been charged, so a partial close can
      // release the right proportion of it.
      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(position.swap.toString()).toBe('-12.5');
    });

    it('credits a short, because the sign comes from the instrument', async () => {
      const { accountId } = await openPosition('SELL', '1.00');
      await service().accrue(new Date('2026-08-24T00:00:00Z'));

      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'SWAP' },
      });
      expect(entry.amount.toString()).toBe('4.75');
    });

    it('scales with volume', async () => {
      const { accountId } = await openPosition('BUY', '2.50');
      await service().accrue(new Date('2026-08-24T00:00:00Z'));
      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'SWAP' },
      });
      expect(entry.amount.toString()).toBe('-31.25');
    });

    /**
     * A position held over Wednesday is financed for three days, because
     * settlement rolls over the weekend. Charging one night would understate a
     * week-long position's cost by two nights every week.
     */
    it('charges three nights on the triple-swap day', async () => {
      const { accountId } = await openPosition('BUY', '1.00');

      // 2026-08-26 is a Wednesday.
      const summary = await service().accrue(new Date('2026-08-26T00:00:00Z'));
      expect(summary.nights).toBe(3);

      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'SWAP' },
      });
      expect(entry.amount.toString()).toBe('-37.5');
    });

    it('honours a different configured triple day', async () => {
      const { accountId } = await openPosition('BUY', '1.00');
      // Friday instead of Wednesday.
      await service({ SWAP_TRIPLE_DAY: 5 }).accrue(new Date('2026-08-28T00:00:00Z'));
      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'SWAP' },
      });
      expect(entry.amount.toString()).toBe('-37.5');
    });

    it('charges a single night every day when weekend financing is disabled', async () => {
      const { accountId } = await openPosition('BUY', '1.00');
      await service({ SWAP_TRIPLE_DAY: -1 }).accrue(new Date('2026-08-26T00:00:00Z'));
      const entry = await prisma.balanceLedger.findFirstOrThrow({
        where: { accountId, type: 'SWAP' },
      });
      expect(entry.amount.toString()).toBe('-12.5');
    });

    /**
     * The property that matters most: a job that runs twice — a retry, a
     * double-scheduled cron, two workers — must not charge the same night twice.
     *
     * Two layers enforce this, and the assertions below pin both. The ledger's
     * unique index on `idempotency_key` is the guarantee: it holds even if the
     * application forgets to look. The in-transaction check is what turns a
     * repeat into a quiet no-op instead of a failed transaction and an alarming
     * log line — which is why the repeat runs must report `accrued: 0` rather
     * than `failed: 1`.
     */
    it('never charges the same night twice', async () => {
      const { accountId } = await openPosition('BUY', '1.00');
      const at = new Date('2026-08-24T00:00:00Z');

      const first = await service().accrue(at);
      const repeat = await service().accrue(at);
      const sameDayLater = await service().accrue(new Date('2026-08-24T23:59:00Z'));

      expect(first.accrued).toBe(1);
      expect(repeat).toMatchObject({ accrued: 1, failed: 0 });
      expect(sameDayLater).toMatchObject({ accrued: 1, failed: 0 });

      expect(await prisma.balanceLedger.count({ where: { accountId, type: 'SWAP' } })).toBe(1);
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('99987.50');

      const position = await prisma.position.findFirstOrThrow({ where: { accountId } });
      expect(position.swap.toString()).toBe('-12.5');
    });

    it('charges again on the next trading day', async () => {
      const { accountId } = await openPosition('BUY', '1.00');
      await service().accrue(new Date('2026-08-24T00:00:00Z'));
      await service().accrue(new Date('2026-08-25T00:00:00Z'));

      expect(await prisma.balanceLedger.count({ where: { accountId, type: 'SWAP' } })).toBe(2);
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('99975.00');
    });

    it('leaves closed positions alone', async () => {
      const { accountId, positionId } = await openPosition('BUY', '1.00');
      await prisma.position.update({
        where: { id: positionId },
        data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'MANUAL' },
      });

      const summary = await service().accrue(new Date('2026-08-24T00:00:00Z'));
      expect(summary.accrued).toBe(0);
      expect(await prisma.balanceLedger.count({ where: { accountId, type: 'SWAP' } })).toBe(0);
    });

    it('posts nothing for an instrument whose swap rate is zero', async () => {
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      await prisma.symbolSpec.update({
        where: { symbolId: symbol.id },
        data: { swapLongPerLot: '0' },
      });
      const { accountId } = await openPosition('BUY', '1.00');

      const summary = await service().accrue(new Date('2026-08-24T00:00:00Z'));
      expect(summary.accrued).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(await prisma.balanceLedger.count({ where: { accountId, type: 'SWAP' } })).toBe(0);
    });

    /**
     * The worker has no market feed and so no FX rate. Skipping and reporting is
     * correct; inventing a rate would put a wrong number into the ledger.
     */
    it('skips a cross-currency position rather than inventing a rate', async () => {
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      await prisma.symbol.update({ where: { id: symbol.id }, data: { quoteCurrency: 'EUR' } });
      const { accountId } = await openPosition('BUY', '1.00');

      const summary = await service().accrue(new Date('2026-08-24T00:00:00Z'));
      expect(summary.skipped).toBe(1);
      expect(summary.accrued).toBe(0);
      expect(await prisma.balanceLedger.count({ where: { accountId, type: 'SWAP' } })).toBe(0);
    });

    it('leaves the ledger reconciled against the cached balance', async () => {
      const { accountId } = await openPosition('BUY', '1.00');
      await service().accrue(new Date('2026-08-24T00:00:00Z'));
      await service().accrue(new Date('2026-08-25T00:00:00Z'));

      const reconciliation = new ReconciliationService(prismaService);
      const summary = await reconciliation.check();
      expect(summary.drifted.filter((d) => d.accountId === accountId)).toHaveLength(0);
    });
  });

  describe('reconciliation', () => {
    const service = () => new ReconciliationService(prismaService);

    it('reports a clean account', async () => {
      await createAccount(prisma, { balance: '100000' });
      const summary = await service().check();
      expect(summary.checked).toBe(1);
      expect(summary.drifted).toHaveLength(0);
      expect(await prisma.riskEvent.count()).toBe(0);
    });

    /**
     * The alarm this job exists to raise: a balance that did not come from the
     * ledger. It is recorded, not repaired — auto-correcting would erase the
     * evidence of how the drift happened.
     */
    it('detects and records a balance that did not come from the ledger', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '100500' } });

      const summary = await service().check();
      expect(summary.drifted).toHaveLength(1);
      expect(summary.drifted[0]?.stored).toBe('100500.00');
      expect(summary.drifted[0]?.replayed).toBe('100000.00');
      expect(summary.drifted[0]?.difference).toBe('500.00');

      const event = await prisma.riskEvent.findFirstOrThrow({
        where: { accountId, rule: 'ledger-reconciliation' },
      });
      expect(event.severity).toBe('CRITICAL');
      expect(event.code).toBe('LEDGER_DRIFT');

      // The stored balance is left exactly as it was found.
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('100500.00');
    });

    it('detects drift in the other direction too', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '99000' } });

      const summary = await service().check();
      expect(summary.drifted[0]?.difference).toBe('-1000.00');
    });

    it('checks every account, not just the first that drifts', async () => {
      const a = await createAccount(prisma, { balance: '100000' });
      const b = await createAccount(prisma, { balance: '50000' });
      await prisma.account.update({ where: { id: a.accountId }, data: { balance: '1' } });
      await prisma.account.update({ where: { id: b.accountId }, data: { balance: '2' } });

      const summary = await service().check();
      expect(summary.checked).toBe(2);
      expect(summary.drifted).toHaveLength(2);
    });
  });

  describe('maintenance', () => {
    const service = () => new MaintenanceService(prismaService);

    const claim = async (key: string, status: string, createdAt: Date, expiresAt: Date) => {
      const row = await prisma.idempotencyKey.create({
        data: { scope: 'orders:test', key, requestHash: 'hash', status, expiresAt },
      });
      // createdAt has a database default, so it is set afterwards.
      await prisma.$executeRawUnsafe(
        `UPDATE idempotency_keys SET created_at = $1 WHERE id = $2::uuid`,
        createdAt,
        row.id,
      );
    };

    it('sweeps expired keys and keeps live ones', async () => {
      const now = new Date('2026-08-24T12:00:00Z');
      await claim('expired', 'COMPLETED', now, new Date('2026-08-23T12:00:00Z'));
      await claim('live', 'COMPLETED', now, new Date('2026-08-25T12:00:00Z'));

      expect(await service().sweepIdempotencyKeys(now)).toBe(1);
      const remaining = await prisma.idempotencyKey.findMany();
      expect(remaining.map((r) => r.key)).toEqual(['live']);
    });

    /**
     * A claim left behind by a process that died would otherwise make that key
     * permanently unusable — the client would be told "already in flight" forever.
     */
    it('releases a claim abandoned by a process that never finished', async () => {
      const now = new Date('2026-08-24T12:00:00Z');
      const expires = new Date('2026-08-25T12:00:00Z');
      await claim('stuck', 'IN_PROGRESS', new Date('2026-08-24T09:00:00Z'), expires);
      await claim('recent', 'IN_PROGRESS', new Date('2026-08-24T11:59:00Z'), expires);
      await claim('done', 'COMPLETED', new Date('2026-08-24T09:00:00Z'), expires);

      expect(await service().releaseAbandonedClaims(now)).toBe(1);
      const remaining = await prisma.idempotencyKey.findMany();
      expect(remaining.map((r) => r.key).sort()).toEqual(['done', 'recent']);
    });
  });
});
