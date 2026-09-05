import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@tp/shared-types';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import { PrismaService } from '../prisma/prisma.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { ExternalExecutionService } from './external-execution.service';
import type { Env } from '../config/env.schema';

export interface RecoverySummary {
  /** Orders old enough to be worth asking about. */
  readonly examined: number;
  /** Orders the venue gave a definite answer for. */
  readonly resolved: number;
  /** Still unconfirmed: the venue could not be reached, or still does not know. */
  readonly unresolved: number;
}

/**
 * Asks venues what became of the orders whose answers were lost.
 *
 * ## The state this exists for
 *
 * An order left this platform and the connection died before the venue's
 * answer came back. The order may be filled, working, or never to have
 * existed at all — and the platform cannot tell which. `UNCONFIRMED` is that
 * ignorance written down, and this sweep is what ends it: it asks the venue,
 * with the same `clientOrderId` that was sent, until the venue says something
 * definite.
 *
 * ## What it will not do
 *
 * **It never resends.** A resend is how one intended trade becomes two
 * positions. The only safe reading of "the venue has no record of it" is that
 * nothing happened, and the order is then cancelled so the trader can decide
 * again at today's prices — not re-placed on their behalf at yesterday's.
 *
 * **It never gives up on the account's behalf.** A venue that cannot be
 * reached leaves the order UNCONFIRMED and the sweep tries again later. An
 * unreachable venue is not evidence about an order, and no number of failed
 * queries turns into one.
 *
 * ## Why it lives in the API and not the worker
 *
 * Resolving an unconfirmed order means applying a venue's answer to orders,
 * executions, positions and the outbox — `ExternalExecutionService`, the one
 * definition of what a venue's answer does to this platform's rows. A second
 * copy of that in the worker would be a second definition of what a fill is,
 * which is exactly the disagreement nobody can settle afterwards. So the
 * schedule moved to the code, as it did for snapshots.
 *
 * ## The grace period
 *
 * An order is not asked about the instant it becomes unconfirmed: the
 * original request may still be in flight at the venue, and a query that
 * overtakes it reads a state that is about to change. `VENUE_RECOVERY_GRACE_MS`
 * is how long the platform waits before deciding the answer really was lost.
 */
@Injectable()
export class VenueRecoveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(VenueRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly external: ExternalExecutionService,
    private readonly tenants: TenantResolver,
  ) {}

  onApplicationBootstrap(): void {
    const interval = this.config.getOrThrow('VENUE_RECOVERY_INTERVAL_MS', { infer: true });
    if (interval <= 0) {
      this.logger.warn(
        'Venue recovery is disabled (VENUE_RECOVERY_INTERVAL_MS=0). ' +
          'Orders whose answers were lost will stay UNCONFIRMED until someone resolves them by hand.',
      );
      return;
    }
    this.running = true;
    this.schedule(interval);
    this.logger.log(`Venue recovery every ${interval}ms`);
  }

  onApplicationShutdown(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Self-rescheduling, so a slow pass is never followed by a burst. */
  private schedule(interval: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.run()
        .catch((error: unknown) => {
          this.logger.error({ err: error }, 'A venue recovery pass failed');
        })
        .finally(() => this.schedule(interval));
    }, interval);
  }

  /** Exposed so tests and the admin console can drive a pass. */
  async run(now = new Date()): Promise<RecoverySummary> {
    const graceMs = this.config.getOrThrow('VENUE_RECOVERY_GRACE_MS', { infer: true });
    const before = new Date(now.getTime() - graceMs);

    const orders = await withoutTenantScope(
      'the sweep recovers every firm’s orders; each is resolved in its own scope',
      () =>
        this.prisma.order.findMany({
          where: { status: OrderStatus.UNCONFIRMED, createdAt: { lte: before } },
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: { id: true, tenantId: true, accountId: true, createdAt: true },
        }),
    );

    const summary = { examined: orders.length, resolved: 0, unresolved: 0 };
    for (const order of orders) {
      const tenant = await this.tenants.byId(order.tenantId);
      // A suspended firm's orders are not abandoned — they are left exactly as
      // they are, to be resolved when the firm is active again.
      if (tenant === null) {
        summary.unresolved += 1;
        continue;
      }
      try {
        const outcome = await withTenant(tenant, () => this.external.resolveUnconfirmed(order.id));
        if (outcome === null || outcome.status === OrderStatus.UNCONFIRMED) {
          summary.unresolved += 1;
        } else {
          summary.resolved += 1;
        }
      } catch (error) {
        /**
         * The venue could not be asked. That is a fact about the venue, not
         * about the order: it stays UNCONFIRMED and is asked again next pass.
         * Nothing here turns an unreachable venue into a trading outcome.
         */
        summary.unresolved += 1;
        this.logger.warn(
          { err: error, orderId: order.id, waitingSince: order.createdAt },
          'Could not ask the venue about an unconfirmed order; it stays unconfirmed',
        );
      }
    }

    if (summary.unresolved > 0) {
      this.logger.warn(summary, 'Orders are still waiting on a venue’s answer');
    } else if (summary.resolved > 0) {
      this.logger.log(summary, 'Venue recovery resolved orders whose answers had been lost');
    }
    return summary;
  }
}
