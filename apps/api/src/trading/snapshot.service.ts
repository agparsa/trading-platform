import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AccountStateService } from './account-state.service';
import type { Env } from '../config/env.schema';
import { requireTenantId } from '../tenancy/tenant-context';

/**
 * Periodic account snapshots.
 *
 * ## Why this lives in the API and not the worker
 *
 * A snapshot is balance, equity, margin and floating P&L — and equity needs live
 * quotes and a valuation of every open position. That valuation is
 * `AccountStateService`, the single place in the platform those numbers are
 * computed, so that the risk engine, the API and the stop-out check cannot
 * disagree about what an account is worth.
 *
 * The worker has neither the quote cache nor that service. Giving it both would
 * mean a second definition of equity, and two definitions of equity is exactly
 * the bug that makes a dispute unresolvable — the snapshot would say one thing
 * and the stop-out that closed the trader's position another.
 *
 * So the schedule moved to the code, rather than the code moving to the
 * schedule. The `account-snapshot` queue is retired.
 *
 * ## Why only accounts that could have changed
 *
 * Valuing every account on the platform every interval is work proportional to
 * registrations. An account with no open positions and no balance movement since
 * its last snapshot has nothing new to record, so it is skipped — cost then
 * scales with activity, which is what actually varies.
 */
@Injectable()
export class SnapshotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SnapshotService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly accountState: AccountStateService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.getOrThrow('ACCOUNT_SNAPSHOT_INTERVAL_MS', { infer: true });
    if (interval <= 0) {
      this.logger.warn('Account snapshots are disabled (ACCOUNT_SNAPSHOT_INTERVAL_MS=0)');
      return;
    }
    this.running = true;
    this.schedule(interval);
    this.logger.log(`Account snapshots every ${interval}ms`);
  }

  onApplicationShutdown(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * A self-rescheduling `setTimeout`, not `setInterval`.
   *
   * `setInterval` queues callbacks behind a slow run and then fires them back to
   * back, so one slow pass would be followed by a burst of snapshots seconds
   * apart. Rescheduling after the work completes cannot do that.
   */
  private schedule(interval: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.run()
        .catch((error: unknown) => {
          // A failed pass must not stop the schedule.
          this.logger.error({ err: error }, 'Account snapshot pass failed');
        })
        .finally(() => this.schedule(interval));
    }, interval);
  }

  /** Exposed so tests can drive a pass without waiting on the clock. */
  async run(at = new Date()): Promise<{ taken: number; skipped: number }> {
    const accounts = await this.candidates();
    let taken = 0;
    let skipped = 0;

    for (const accountId of accounts) {
      try {
        const valuation = await this.accountState.valuate(accountId);
        const { state } = valuation;
        await this.prisma.accountSnapshot.upsert({
          // Idempotent on (accountId, takenAt): a retry after a partial pass
          // corrects the row rather than creating a second one for the instant.
          where: { accountId_takenAt: { accountId, takenAt: at } },
          create: {
            tenantId: requireTenantId(),
            accountId,
            takenAt: at,
            balance: state.balance.toString(),
            equity: state.equity.toString(),
            usedMargin: state.usedMargin.toString(),
            freeMargin: state.freeMargin.toString(),
            marginLevel: state.marginLevel === null ? null : state.marginLevel.toString(),
            floatingPnl: state.floatingPnl.toString(),
            openPositions: valuation.openPositionCount,
          },
          update: {
            balance: state.balance.toString(),
            equity: state.equity.toString(),
            usedMargin: state.usedMargin.toString(),
            freeMargin: state.freeMargin.toString(),
            marginLevel: state.marginLevel === null ? null : state.marginLevel.toString(),
            floatingPnl: state.floatingPnl.toString(),
            openPositions: valuation.openPositionCount,
          },
        });
        taken += 1;
      } catch (error) {
        // One account that cannot be valued — an instrument with no quote, say —
        // must not cost every other account its snapshot.
        skipped += 1;
        this.logger.error({ err: error, accountId }, 'Skipped an account snapshot');
      }
    }

    return { taken, skipped };
  }

  /**
   * Accounts worth valuing: those holding a position, or whose balance has moved
   * since their last snapshot.
   *
   * A dormant account's equity is its balance, and its last snapshot already says
   * so. Re-recording it every interval would fill the table with rows that carry
   * no information and make the history harder to read, not easier.
   */
  private async candidates(): Promise<string[]> {
    const [withPositions, recentlyMoved] = await Promise.all([
      this.prisma.position.findMany({
        where: { status: { in: ['OPEN', 'CLOSING'] } },
        select: { accountId: true },
        distinct: ['accountId'],
      }),
      this.prisma.$queryRaw<Array<{ account_id: string }>>`
        SELECT DISTINCT l.account_id
        FROM balance_ledger l
        LEFT JOIN LATERAL (
          SELECT taken_at FROM account_snapshots s
          WHERE s.account_id = l.account_id
          ORDER BY s.taken_at DESC LIMIT 1
        ) last ON TRUE
        WHERE last.taken_at IS NULL OR l.created_at > last.taken_at
      `,
    ]);

    const ids = new Set(withPositions.map((row) => row.accountId));
    for (const row of recentlyMoved) ids.add(row.account_id);
    return [...ids];
  }
}
