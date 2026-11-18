import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withTenant, withoutTenantScope } from '@tp/tenancy';
import type { Env } from '../config/env.schema';
import { LeadershipService, LeaderLoop } from '../leadership/leadership.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantResolver } from '../tenancy/tenant-resolver.service';
import { ChallengesService } from './challenges.service';

/**
 * Runs the challenge evaluator on one instance at a time.
 *
 * Behind its own lease, like price alerts. Two instances deciding the same
 * challenge would be caught by the version check on every transition, but
 * the lease means it does not have to be — and one process's log is where to
 * look for why a challenge ended.
 */
@Injectable()
export class ChallengesRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChallengesRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly challenges: ChallengesService,
    private readonly leadership: LeadershipService,
    private readonly tenants: TenantResolver,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.getOrThrow('CHALLENGE_EVALUATION_ENABLED', { infer: true })) {
      this.logger.warn('Challenge evaluation is disabled on this instance');
      return;
    }
    this.leadership.campaign(LeaderLoop.CHALLENGES, {
      onAcquired: () => this.schedule(),
      onLost: () => this.unschedule(),
    });
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    this.unschedule();
  }

  /** One pass over every firm with a running challenge. Exposed for tests. */
  async sweep(now = new Date()): Promise<number> {
    if (!this.leadership.isLeading(LeaderLoop.CHALLENGES)) return 0;
    const tenantIds = await withoutTenantScope(
      'the challenge evaluator serves every firm with a running challenge',
      async () =>
        (
          await this.prisma.challenge.findMany({
            where: { status: { in: ['ACTIVE', 'FUNDED'] } },
            distinct: ['tenantId'],
            select: { tenantId: true },
          })
        ).map((row) => row.tenantId),
    );
    let evaluated = 0;
    for (const tenantId of tenantIds) {
      const tenant = await this.tenants.byId(tenantId);
      if (tenant === null) continue;
      try {
        const counts = await withTenant(tenant, () => this.challenges.evaluateAll(now));
        evaluated += counts.ONGOING + counts.FAILED + counts.ADVANCED;
      } catch (error) {
        this.logger.error({ err: error, tenantId }, 'Challenge pass failed for a tenant');
      }
    }
    return evaluated;
  }

  private schedule(): void {
    if (this.timer !== null || this.stopped) return;
    const interval = this.config.getOrThrow('CHALLENGE_EVALUATION_INTERVAL_MS', { infer: true });
    const run = (): void => {
      this.timer = setTimeout(() => {
        void this.sweep()
          .catch((error: unknown) => this.logger.error({ err: error }, 'Challenge pass failed'))
          .finally(() => {
            this.timer = null;
            if (!this.stopped && this.leadership.isLeading(LeaderLoop.CHALLENGES)) run();
          });
      }, interval);
      this.timer.unref?.();
    };
    run();
    this.logger.log('Challenges are being evaluated on this instance');
  }

  private unschedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
