import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { SwapAccrualService } from '../../src/jobs/swap-accrual.service';
import { ReconciliationService } from '../../src/jobs/reconciliation.service';
import { MaintenanceService } from '../../src/jobs/maintenance.service';
import type { PrismaService } from '../../src/prisma.service';
import { outsideAnyScope, withTenant, withoutTenantScope } from '@tp/tenancy';
import {
  createAccount,
  createTestClient,
  hasTestDatabase,
  resetDatabase,
  seedSymbols,
  DEFAULT_TENANT_ID,
  createTenant,
  simulatingCorruption,
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
  /**
   * A position, with the order and execution that opened it.
   *
   * The order and the execution used to be omitted — the position row alone was
   * enough for a swap test, and creating the rest was noise. Reconciliation
   * disagreed the first time it ran against this fixture: a position no
   * execution ever opened is not a position any code path in this system can
   * produce, and a test built on one is testing against a shape that cannot
   * exist. It costs eight lines to be a real position instead.
   */
  const openPosition = async (
    side: 'BUY' | 'SELL',
    volume: string,
    accountBalance = '100000',
    tenantId: string = DEFAULT_TENANT_ID,
  ) =>
    /**
     * The whole fixture is built inside its tenant's scope.
     *
     * Passing `tenantId` alone is not enough and should not be: the extension
     * refuses a row written for a tenant that is not in scope, which is exactly
     * the check that catches a service using an id it got from somewhere else.
     * A test fixture is not an exception to that.
     */
    withTenant({ tenantId, slug: tenantId }, async () => {
      const { userId, accountId } = await createAccount(prisma, {
        balance: accountBalance,
        tenantId,
      });
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });
      const position = await prisma.position.create({
        data: {
          tenantId,
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
      const order = await prisma.order.create({
        data: {
          tenantId,
          accountId,
          symbolId: symbol.id,
          positionId: position.id,
          side,
          type: 'MARKET',
          status: 'FILLED',
          timeInForce: 'IOC',
          volume,
          filledVolume: volume,
        },
      });
      await prisma.execution.create({
        data: {
          tenantId,
          orderId: order.id,
          accountId,
          side,
          volume,
          price: '4583.72',
          quoteBid: '4583.58',
          quoteAsk: '4583.72',
          quoteAt: new Date(),
        },
      });
      return { userId, accountId, positionId: position.id };
    });

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
      expect(summary.reports.filter((report) => report.accountId === accountId)).toHaveLength(0);
    });
  });

  describe('across tenants', () => {
    const swap = (overrides: Record<string, unknown> = {}) =>
      new SwapAccrualService(prismaService, buildConfig(overrides) as never);

    /**
     * The worker is the one process with no request and no middleware, so
     * nothing puts a tenant in scope for it. Its sweeps are deliberately
     * cross-tenant and its writes are deliberately not — and the difference is
     * what these tests hold in place.
     */
    it('charges financing on every tenant’s positions, and files each under its own', async () => {
      const beta = await createTenant(prisma, 'beta');
      const alpha = await openPosition('BUY', '1.00');
      const other = await openPosition('BUY', '2.00', '100000', beta);

      const summary = await swap().accrue(new Date('2026-08-24T00:00:00Z'));
      expect(summary.accrued).toBe(2);

      const alphaEntry = await withTenant({ tenantId: DEFAULT_TENANT_ID, slug: 'a' }, () =>
        prisma.balanceLedger.findFirstOrThrow({
          where: { accountId: alpha.accountId, type: 'SWAP' },
        }),
      );
      const betaEntry = await withTenant({ tenantId: beta, slug: 'b' }, () =>
        prisma.balanceLedger.findFirstOrThrow({
          where: { accountId: other.accountId, type: 'SWAP' },
        }),
      );

      expect(alphaEntry.tenantId).toBe(DEFAULT_TENANT_ID);
      expect(betaEntry.tenantId).toBe(beta);
      // Two lots, so twice the charge — proof the right position was read for
      // the right ledger rather than one entry being written twice.
      expect(alphaEntry.amount.toString()).toBe('-12.5');
      expect(betaEntry.amount.toString()).toBe('-25');
    });

    it('does not let one tenant’s ledger see the other’s financing', async () => {
      const beta = await createTenant(prisma, 'beta');
      await openPosition('BUY', '1.00');
      await openPosition('BUY', '2.00', '100000', beta);
      await swap().accrue(new Date('2026-08-24T00:00:00Z'));

      const alphaSwaps = await withTenant({ tenantId: DEFAULT_TENANT_ID, slug: 'a' }, () =>
        prisma.balanceLedger.findMany({ where: { type: 'SWAP' } }),
      );
      expect(alphaSwaps).toHaveLength(1);
      expect(alphaSwaps[0]?.tenantId).toBe(DEFAULT_TENANT_ID);
    });

    it('reconciles every tenant, not only the one that asked', async () => {
      /**
       * The failure this guards is quiet: a sweep restricted to one tenant
       * reports itself clean, and every other tenant's drift goes unlooked-for
       * while an operator reads a green dashboard.
       */
      const beta = await createTenant(prisma, 'beta');
      const alpha = await openPosition('BUY', '1.00');
      const other = await openPosition('BUY', '1.00', '100000', beta);

      // Drift both accounts: the cached balance no longer matches the ledger.
      for (const id of [alpha.accountId, other.accountId]) {
        await prisma.$executeRawUnsafe(
          `UPDATE accounts SET balance = balance + 500 WHERE id = $1::uuid`,
          id,
        );
      }

      const summary = await new ReconciliationService(prismaService).check();
      expect(summary.checked).toBe(2);

      const findings = await withoutTenantScope('test: assert across both tenants', () =>
        prisma.reconciliationFinding.findMany(),
      );
      expect(new Set(findings.map((f) => f.tenantId))).toEqual(new Set([DEFAULT_TENANT_ID, beta]));
    });
  });

  describe('reconciliation', () => {
    const service = () => new ReconciliationService(prismaService);

    it('reports a clean account', async () => {
      await createAccount(prisma, { balance: '100000' });
      const summary = await service().check();
      expect(summary.checked).toBe(1);
      expect(summary.findings).toBe(0);
      expect(summary.reports).toHaveLength(0);
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
      expect(summary.reports).toHaveLength(1);
      const drift = summary.reports[0]?.findings.find((f) => f.code === 'LEDGER_DRIFT');
      expect(drift?.actual).toBe('100500');
      expect(drift?.expected).toBe('100000');
      expect(drift?.difference).toBe('500');

      const event = await prisma.riskEvent.findFirstOrThrow({
        where: { accountId, rule: 'reconciliation' },
      });
      expect(event.severity).toBe('CRITICAL');
      expect(event.code).toBe('LEDGER_DRIFT');

      // The stored balance is left exactly as it was found.
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(Money.of(account.balance.toString(), 'USD').toString()).toBe('100500.00');
    });

    /**
     * A run is recorded even when it finds nothing, and that is the point.
     * "The last run was clean" and "there has been no run since Tuesday" look
     * identical if only findings are stored, and only one of them is
     * reassuring.
     */
    it('records the run itself, clean or not', async () => {
      await createAccount(prisma, { balance: '100000' });
      const summary = await service().check();

      const run = await prisma.reconciliationRun.findUniqueOrThrow({
        where: { id: summary.runId },
      });
      expect(run.status).toBe('COMPLETED');
      expect(run.trigger).toBe('SCHEDULED');
      expect(run.accountsChecked).toBe(1);
      expect(run.findingsRaised).toBe(0);
      expect(run.finishedAt).not.toBeNull();
      expect(run.durationMs).not.toBeNull();
    });

    it('carries the run id and trigger a person asked for', async () => {
      const requested = await prisma.reconciliationRun.create({
        data: { tenantId: DEFAULT_TENANT_ID, trigger: 'MANUAL' },
      });
      const summary = await service().check({ runId: requested.id, trigger: 'MANUAL' });

      expect(summary.runId).toBe(requested.id);
      const run = await prisma.reconciliationRun.findUniqueOrThrow({ where: { id: requested.id } });
      expect(run.status).toBe('COMPLETED');
      expect(run.trigger).toBe('MANUAL');
    });

    it('writes a finding row alongside the risk event', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '100500' } });

      const summary = await service().check();
      expect(summary.raised).toBe(1);
      expect(summary.recurred).toBe(0);

      const finding = await prisma.reconciliationFinding.findFirstOrThrow({
        where: { accountId, code: 'LEDGER_DRIFT' },
      });
      expect(finding.status).toBe('OPEN');
      expect(finding.severity).toBe('CRITICAL');
      expect(finding.expected).toBe('100000');
      expect(finding.actual).toBe('100500');
      expect(finding.difference).toBe('500');
      expect(finding.occurrences).toBe(1);
      expect(finding.runId).toBe(summary.runId);
    });

    /**
     * A drift that is still there on the next run is the same drift seen again,
     * not a second one. A thousand duplicate rows would bury the one fact an
     * investigator wants: how long this has been true.
     */
    it('counts a recurrence rather than filing it twice', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '100500' } });

      await service().check();
      const second = await service().check();

      expect(second.raised).toBe(0);
      expect(second.recurred).toBe(1);
      expect(await prisma.reconciliationFinding.count({ where: { accountId } })).toBe(1);

      const finding = await prisma.reconciliationFinding.findFirstOrThrow({ where: { accountId } });
      expect(finding.occurrences).toBe(2);
      expect(finding.lastSeenAt.getTime()).toBeGreaterThanOrEqual(finding.firstSeenAt.getTime());
    });

    /**
     * The one that stops a tick put there in good faith from hiding a real
     * inconsistency. Somebody closed it; the drift is still there; it comes
     * back open.
     */
    it('reopens a finding that had been resolved and has come back', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '100500' } });
      await service().check();

      await prisma.reconciliationFinding.updateMany({
        where: { accountId },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionNote: 'Looked into it, all fine',
        },
      });

      await service().check();

      const finding = await prisma.reconciliationFinding.findFirstOrThrow({ where: { accountId } });
      expect(finding.status).toBe('OPEN');
      expect(finding.resolvedAt).toBeNull();
      expect(finding.resolutionNote).toBeNull();
    });

    /**
     * §49: a firm can be told. Until this existed the finding sat in a table
     * nobody outside the admin panel watched, and the webhook catalogue listed
     * an event that was never produced — a subscription that reassures.
     *
     * What is pinned here is the *rate*, because that is the part that decides
     * whether the event is read: a first sighting sends, a drift that is
     * simply still there does not, and a finding somebody closed that has come
     * back sends again and says so.
     */
    it('tells the firm once when a mismatch is raised, again when it comes back, never for a recurrence', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '100500' } });

      const first = await service().check();

      const raised = await prisma.outboxEvent.findMany({
        where: { eventType: 'reconciliation.mismatch' },
      });
      expect(raised).toHaveLength(1);
      const event = raised[0];
      expect(event?.accountId).toBe(accountId);
      expect(event?.aggregateType).toBe('account');
      expect(event?.aggregateId).toBe(accountId);
      expect(event?.actorId).toBeNull();
      expect(event?.correlationId).toBe(first.runId);
      const payload = event?.payload as Record<string, unknown>;
      expect(payload['code']).toBe('LEDGER_DRIFT');
      expect(payload['severity']).toBe('CRITICAL');
      expect(payload['expected']).toBe('100000');
      expect(payload['actual']).toBe('100500');
      expect(payload['difference']).toBe('500');
      expect(payload['reopened']).toBe(false);

      // Still drifting, still the same fact: no second event.
      await service().check();
      expect(
        await prisma.outboxEvent.count({ where: { eventType: 'reconciliation.mismatch' } }),
      ).toBe(1);

      // Somebody closed it in good faith and it is still true.
      await prisma.reconciliationFinding.updateMany({
        where: { accountId },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolutionNote: 'Looked into it' },
      });
      await service().check();

      const all = await prisma.outboxEvent.findMany({
        where: { eventType: 'reconciliation.mismatch' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(all).toHaveLength(2);
      expect((all[1]?.payload as Record<string, unknown>)['reopened']).toBe(true);
      // One occurrence, one id: the relay's uniqueness rests on it.
      expect(new Set(all.map((row) => row.eventId)).size).toBe(2);
    });

    /**
     * The finding, the risk event and the outbox row commit together or not at
     * all. If the finding could commit alone, the next sweep would call the
     * drift a recurrence and send nothing — the alert lost rather than late.
     */
    it('does not record a finding when the event it owes cannot be written', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '100500' } });

      const broken = new ReconciliationService(
        new Proxy(prismaService, {
          get(target, property, receiver) {
            if (property === '$transaction') {
              return async (fn: (tx: unknown) => Promise<unknown>) =>
                (
                  target as unknown as { $transaction: (f: unknown) => Promise<unknown> }
                ).$transaction(async (tx: Record<string, unknown>) =>
                  fn(
                    new Proxy(tx, {
                      get(inner, key, self) {
                        if (key === 'outboxEvent') {
                          return {
                            create: async () => {
                              throw new Error('the outbox went away');
                            },
                          };
                        }
                        return Reflect.get(inner, key, self);
                      },
                    }),
                  ),
                );
            }
            return Reflect.get(target, property, receiver);
          },
        }) as unknown as PrismaService,
      );

      await expect(broken.check()).rejects.toThrow('the outbox went away');
      expect(await prisma.reconciliationFinding.count({ where: { accountId } })).toBe(0);
      expect(await prisma.riskEvent.count({ where: { accountId } })).toBe(0);
    });

    it('records a failed run as failed, not as a clean one', async () => {
      const broken = new ReconciliationService({
        // The tenant lookup is real: a sweep files its run under a tenant
        // before it reads a single account, and stubbing it away would make
        // this test fail on the wrong thing.
        tenant: prismaService.tenant,
        reconciliationRun: prismaService.reconciliationRun,
        account: {
          findMany: async () => {
            throw new Error('the database went away');
          },
        },
      } as unknown as PrismaService);

      await expect(broken.check()).rejects.toThrow('the database went away');

      const run = await prisma.reconciliationRun.findFirstOrThrow({
        orderBy: { startedAt: 'desc' },
      });
      expect(run.status).toBe('FAILED');
      expect(run.error).toContain('the database went away');
      expect(run.finishedAt).not.toBeNull();
    });

    it('detects drift in the other direction too', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '99000' } });

      const summary = await service().check();
      const drift = summary.reports[0]?.findings.find((f) => f.code === 'LEDGER_DRIFT');
      expect(drift?.difference).toBe('-1000');
    });

    /**
     * The checks that need a real database, because the thing being verified is
     * that the *loader* asks the right questions — a pure test can only prove
     * the arithmetic, and the arithmetic was never the part likely to be wrong.
     */
    it('detects a filled order whose execution never happened', async () => {
      const { accountId, positionId } = await openPosition('BUY', '1.00');
      /**
       * The corruption *is* the subject here: a filled order with no execution
       * cannot be produced by asking the service for one, because the service
       * is what makes the two agree. `executions` refuses DELETE now, so the
       * guard comes off for exactly this statement and goes straight back on.
       */
      await simulatingCorruption(prisma, ['executions'], () =>
        prisma.execution.deleteMany({ where: { accountId } }),
      );

      const summary = await service().check();
      const codes = summary.reports[0]?.findings.map((f) => f.code) ?? [];
      expect(codes).toContain('FILLED_ORDER_WITHOUT_EXECUTION');
      expect(codes).toContain('POSITION_WITHOUT_OPENING_EXECUTION');
      expect(positionId).toBeDefined();
    });

    it('detects a position holding volume its executions never opened', async () => {
      const { positionId } = await openPosition('BUY', '1.00');
      await prisma.position.update({ where: { id: positionId }, data: { volume: '2.00' } });

      const summary = await service().check();
      const found = summary.reports[0]?.findings.find((f) => f.code === 'POSITION_VOLUME_MISMATCH');
      expect(found?.expected).toBe('1');
      expect(found?.actual).toBe('2');
    });

    /**
     * The closing side of the volume check.
     *
     * Without a position that has actually been closed into, netting is
     * indistinguishable from summing — a loader that added every execution
     * regardless of side passed the whole suite, because nothing in it had ever
     * closed anything. This is the case that makes the distinction load-bearing.
     */
    it('nets a closing execution against the opening one', async () => {
      const { accountId, positionId } = await openPosition('BUY', '1.00');
      const symbol = await prisma.symbol.findUniqueOrThrow({ where: { code: 'XAUUSD' } });

      // Half the position closed: an order on the opposite side, its execution,
      // and the position reduced to match.
      const closingOrder = await prisma.order.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          accountId,
          symbolId: symbol.id,
          positionId,
          side: 'SELL',
          type: 'MARKET',
          status: 'FILLED',
          timeInForce: 'IOC',
          volume: '0.40',
          filledVolume: '0.40',
        },
      });
      await prisma.execution.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          orderId: closingOrder.id,
          accountId,
          side: 'SELL',
          volume: '0.40',
          price: '4590.00',
          quoteBid: '4590.00',
          quoteAsk: '4590.14',
          quoteAt: new Date(),
        },
      });
      await prisma.position.update({ where: { id: positionId }, data: { volume: '0.60' } });

      const clean = await service().check();
      expect(clean.reports.filter((r) => r.accountId === accountId)).toHaveLength(0);

      // And the same books with the position left un-reduced — a close that
      // wrote its execution but never took the volume off — must be caught.
      await prisma.position.update({ where: { id: positionId }, data: { volume: '1.00' } });
      const dirty = await service().check();
      const found = dirty.reports
        .find((r) => r.accountId === accountId)
        ?.findings.find((f) => f.code === 'POSITION_VOLUME_MISMATCH');
      expect(found?.expected).toBe('0.6');
      expect(found?.actual).toBe('1');
    });

    it('records every finding, and corrects none of them', async () => {
      const { accountId, positionId } = await openPosition('BUY', '1.00');
      await prisma.account.update({ where: { id: accountId }, data: { balance: '99999' } });
      await prisma.position.update({ where: { id: positionId }, data: { volume: '5.00' } });

      await service().check();

      const events = await prisma.riskEvent.findMany({
        where: { accountId, rule: 'reconciliation' },
      });
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every((event) => event.severity === 'CRITICAL')).toBe(true);

      // Everything is left exactly as it was found. DETECTED → RECORDED →
      // ALERTED; the correction is a person's deliberate, audited act.
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      const position = await prisma.position.findUniqueOrThrow({ where: { id: positionId } });
      expect(account.balance.toString()).toBe('99999');
      expect(position.volume.toString()).toBe('5');
    });

    it('checks every account, not just the first that drifts', async () => {
      const a = await createAccount(prisma, { balance: '100000' });
      const b = await createAccount(prisma, { balance: '50000' });
      await prisma.account.update({ where: { id: a.accountId }, data: { balance: '1' } });
      await prisma.account.update({ where: { id: b.accountId }, data: { balance: '2' } });

      const summary = await service().check();
      expect(summary.checked).toBe(2);
      expect(summary.reports).toHaveLength(2);
    });
  });

  describe('maintenance', () => {
    const service = () => new MaintenanceService(prismaService);

    const claim = async (key: string, status: string, createdAt: Date, expiresAt: Date) => {
      const row = await prisma.idempotencyKey.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          scope: 'orders:test',
          key,
          requestHash: 'hash',
          status,
          expiresAt,
        },
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

  /**
   * A queue hands a job nothing: no request, no tenant, no scope. Every job has
   * to open its own, and every test in this file had been proving the opposite
   * — the harness enters a tenant in `beforeEach`, so a job that forgot ran
   * happily here and was refused in production on its first write. That is
   * how the scheduled reconciliation failed five times an hour for weeks,
   * with the console showing no run since the day tenancy went live.
   *
   * So each entry point the registry attaches is driven from *outside* any
   * scope, which is the state it actually starts in.
   */
  describe('jobs open their own scope', () => {
    it('reconciliation, scheduled: the run row and its closing update', async () => {
      const { accountId } = await createAccount(prisma, { balance: '100000' });
      await prisma.account.update({ where: { id: accountId }, data: { balance: '100500' } });

      const summary = await outsideAnyScope(() =>
        new ReconciliationService(prismaService).check({ trigger: 'SCHEDULED' }),
      );

      expect(summary.checked).toBe(1);
      expect(summary.findings).toBe(1);
      const run = await prisma.reconciliationRun.findUniqueOrThrow({
        where: { id: summary.runId },
      });
      expect(run.status).toBe('COMPLETED');
      expect(run.tenantId).toBe(DEFAULT_TENANT_ID);
      expect(await prisma.reconciliationFinding.count({ where: { accountId } })).toBe(1);
    });

    it('reconciliation, requested: finds the tenant the API filed the run under', async () => {
      const other = await createTenant(prisma, 'other-firm');
      const requested = await withTenant({ tenantId: other, slug: 'other-firm' }, () =>
        prisma.reconciliationRun.create({ data: { tenantId: other, trigger: 'MANUAL' } }),
      );

      const summary = await outsideAnyScope(() =>
        new ReconciliationService(prismaService).check({ runId: requested.id, trigger: 'MANUAL' }),
      );

      expect(summary.runId).toBe(requested.id);
      const run = await withoutTenantScope('the test reads back a row in another tenant', () =>
        prisma.reconciliationRun.findUniqueOrThrow({ where: { id: requested.id } }),
      );
      expect(run.status).toBe('COMPLETED');
      expect(run.tenantId).toBe(other);
    });

    it('reconciliation, failed: the failure is still recorded', async () => {
      await createAccount(prisma, { balance: '100000' });
      const broken = new ReconciliationService({
        tenant: prismaService.tenant,
        reconciliationRun: prismaService.reconciliationRun,
        account: {
          findMany: async () => {
            throw new Error('the database went away');
          },
        },
      } as unknown as PrismaService);

      await expect(outsideAnyScope(() => broken.check())).rejects.toThrow('went away');
      const run = await prisma.reconciliationRun.findFirstOrThrow({
        orderBy: { startedAt: 'desc' },
      });
      expect(run.status).toBe('FAILED');
      expect(run.error).toContain('went away');
    });

    it('swap accrual', async () => {
      await openPosition('BUY', '1.00');
      const summary = await outsideAnyScope(() =>
        new SwapAccrualService(prismaService, buildConfig() as never).accrue(
          new Date('2026-08-24T22:00:00Z'),
        ),
      );
      expect(summary.failed).toBe(0);
    });

    it('maintenance, every sweep', async () => {
      const maintenance = new MaintenanceService(prismaService);
      await expect(
        outsideAnyScope(async () => ({
          expired: await maintenance.sweepIdempotencyKeys(),
          abandoned: await maintenance.releaseAbandonedClaims(),
          payments: await maintenance.expireStalePayments(),
          verifications: await maintenance.expireVerifications(),
          documents: await maintenance.purgeIdentityDocuments(365),
        })),
      ).resolves.toEqual({
        expired: 0,
        abandoned: 0,
        payments: 0,
        verifications: 0,
        documents: 0,
      });
    });
  });
});
