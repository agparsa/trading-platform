import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import type { Env } from '../config/env.schema';

/** The singleton loops this deployment elects a leader for. */
export const LeaderLoop = {
  TRIGGER_ENGINE: 'trigger-engine',
  MARKET_INGEST: 'market-ingest',
  PRICE_ALERTS: 'price-alerts',
} as const;
export type LeaderLoopName = (typeof LeaderLoop)[keyof typeof LeaderLoop];

export interface LeaseRow {
  readonly name: string;
  readonly holder: string;
  readonly term: bigint;
  readonly acquiredAt: Date;
  readonly renewedAt: Date;
  readonly expiresAt: Date;
}

export interface Campaign {
  /** Called when this process becomes the leader, once per term. */
  readonly onAcquired: () => void | Promise<void>;
  /** Called when this process stops being the leader, once per term. */
  readonly onLost: (reason: LeadershipLossReason) => void | Promise<void>;
}

export type LeadershipLossReason =
  /** Another process holds a live lease. */
  | 'TAKEN'
  /** The renewal did not complete — the database was unreachable. */
  | 'RENEW_FAILED'
  /** The lease is close enough to expiry that acting on it is not safe. */
  | 'EXPIRING'
  /** This process is shutting down. */
  | 'SHUTDOWN';

interface CampaignState {
  readonly name: string;
  readonly hooks: Campaign;
  leading: boolean;
  term: bigint;
  /** `Date.now()` past which this process must stop acting as the leader. */
  deadline: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Decides which process runs a loop that must run in exactly one place.
 *
 * ## Why a lease and not a flag
 *
 * The trigger engine used to be turned on by `TRIGGER_ENGINE_ENABLED=true` on
 * one container. That is a convention held up by whoever last edited the
 * compose file. A rolling deploy overlaps the old container and the new one for
 * as long as the old one takes to drain; `--scale api-ingest=2` typed once does
 * the same thing permanently. Two trigger engines on one tick means one
 * position stopped out twice and one resting order filled twice, and the second
 * of each is a trade the trader never asked for.
 *
 * So the flag now means "this process is *allowed* to contend", and the lease
 * decides which contender actually runs.
 *
 * ## Why the database's clock
 *
 * Every timestamp in the acquire statement comes from `now()` inside Postgres.
 * Contenders never compare their own clocks with each other's — only with the
 * database's, which all of them share. A container with a clock an hour fast
 * cannot talk itself into leadership.
 *
 * ## What a lease cannot do
 *
 * This is stated plainly because pretending otherwise is how these go wrong: a
 * lease does not make two leaders impossible. A leader that stalls — a long GC
 * pause, a partition from the database, a suspended VM — can wake up past its
 * expiry believing it still leads, while a successor has already taken over.
 *
 * Three things narrow that window, and none of them closes it:
 *
 *   1. Renewal runs at a third of the TTL, so a renewal has to fail twice
 *      before the lease lapses.
 *   2. The holder records a *local* deadline at renewal and refuses to act once
 *      `Date.now()` is within `LEADER_GUARD_MS` of it. A stalled process that
 *      wakes late therefore stands down on its own, without needing to reach
 *      the database first — which is exactly the moment it cannot.
 *   3. Losing the lease is delivered to the loop, which detaches. Nothing keeps
 *      running on the strength of having been the leader earlier.
 *
 * The remaining exposure is a process that stalls for less than the guard
 * interval and is unlucky. That is why the writes underneath — closing a
 * position, filling an order — remain conditional on the row's current state
 * inside their own transaction. Leadership reduces contention; it is not what
 * makes those writes safe.
 */
@Injectable()
export class LeadershipService implements OnApplicationShutdown {
  private readonly logger = new Logger(LeadershipService.name);
  /** Random per boot. Never reused, so a restarted container is a new holder. */
  readonly instanceId = randomUUID();
  private readonly campaigns = new Map<string, CampaignState>();
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly metrics: MetricsService,
  ) {}

  private get ttlMs(): number {
    return this.config.getOrThrow('LEADER_LEASE_TTL_MS', { infer: true });
  }

  private get renewMs(): number {
    return this.config.getOrThrow('LEADER_RENEW_INTERVAL_MS', { infer: true });
  }

  private get guardMs(): number {
    return this.config.getOrThrow('LEADER_GUARD_MS', { infer: true });
  }

  /**
   * Start contending for `name`.
   *
   * Returns immediately; `onAcquired` fires on the first successful acquisition,
   * which may be on the first attempt or twenty minutes later when the current
   * holder is redeployed. A caller that must not run before then does nothing
   * in its own bootstrap and everything in `onAcquired`.
   */
  campaign(name: LeaderLoopName, hooks: Campaign): void {
    if (this.campaigns.has(name)) {
      throw new Error(`Already campaigning for '${name}'`);
    }
    const state: CampaignState = {
      name,
      hooks,
      leading: false,
      term: 0n,
      deadline: 0,
      timer: null,
    };
    this.campaigns.set(name, state);
    void this.tick(state);
  }

  /**
   * Whether this process may act as the leader of `name` *right now*.
   *
   * Checked before each pass rather than once at attach time: the answer
   * changes underneath a running loop, and the local deadline makes this
   * answerable without a database round trip — which matters because the moment
   * leadership is most likely to be gone is the moment the database is hardest
   * to reach.
   */
  isLeading(name: LeaderLoopName): boolean {
    const state = this.campaigns.get(name);
    if (state === undefined || !state.leading) return false;
    return Date.now() < state.deadline - this.guardMs;
  }

  /** The term this process holds for `name`, or `null` if it does not lead it. */
  term(name: LeaderLoopName): bigint | null {
    const state = this.campaigns.get(name);
    return state !== undefined && state.leading ? state.term : null;
  }

  /** Every lease on record, for the operations console. */
  async leases(): Promise<readonly LeaseRow[]> {
    const rows = await this.prisma.leaderLease.findMany({ orderBy: { name: 'asc' } });
    return rows;
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const state of this.campaigns.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      if (state.leading) await this.stepDown(state, 'SHUTDOWN');
    }
    /**
     * Hand the lease back rather than letting it lapse.
     *
     * Without this, a redeploy leaves the trigger engine unled for a whole TTL
     * — during which stop-losses do not fire. Releasing on the way out turns
     * that into the time the successor takes to notice, which is one renewal
     * interval at worst.
     */
    try {
      await this.prisma.leaderLease.updateMany({
        where: { holder: this.instanceId },
        data: { expiresAt: new Date(0) },
      });
    } catch (error) {
      // Shutdown. The lease expires on its own; say so and go.
      this.logger.warn({ err: error }, 'Could not release leases on shutdown');
    }
  }

  /** One acquire-or-renew attempt, then reschedule. Never throws. */
  private async tick(state: CampaignState): Promise<void> {
    if (this.shuttingDown) return;
    try {
      const row = await this.acquire(state.name);
      if (row === null) {
        if (state.leading) await this.stepDown(state, 'TAKEN');
      } else {
        state.deadline = row.expiresAt.getTime();
        if (!state.leading || row.term !== state.term) {
          state.leading = true;
          state.term = row.term;
          this.metrics.leaderLease.set({ loop: state.name }, 1);
          this.metrics.leaderTransitions.inc({ loop: state.name, transition: 'acquired' });
          this.logger.log(
            { loop: state.name, term: row.term.toString(), holder: this.instanceId },
            'Leadership acquired',
          );
          await this.safely(state, () => state.hooks.onAcquired());
        }
      }
    } catch (error) {
      /**
       * The database is unreachable. That is not evidence that somebody else
       * took the lease — but it is evidence that this process can no longer
       * prove it still holds one, and a singleton loop that cannot prove it
       * must stop. This is the same principle the venue recovery sweep works
       * on: an unreachable dependency decides nothing, it only stops us.
       */
      this.logger.error({ loop: state.name, err: error }, 'Lease renewal failed');
      if (state.leading) await this.stepDown(state, 'RENEW_FAILED');
    } finally {
      if (!this.shuttingDown) {
        state.timer = setTimeout(() => void this.tick(state), this.renewMs);
        state.timer.unref();
      }
    }
  }

  /**
   * Take the lease, or renew it, in one statement.
   *
   * The `WHERE` on the conflict branch is what makes this safe under
   * concurrency: Postgres serialises conflicting upserts on the primary key, so
   * of two contenders arriving together exactly one finds `expires_at < now()`
   * and the other finds a lease that is no longer expired. There is no
   * read-then-write to lose a race in.
   *
   * `term` is deliberately left alone when the holder is unchanged. A renewal
   * is not a change of leadership and should not read like one in the console.
   *
   * Returns `null` when somebody else holds a live lease.
   */
  private async acquire(name: string): Promise<LeaseRow | null> {
    const startedAt = Date.now();
    const rows = await this.prisma.$queryRaw<
      Array<{
        name: string;
        holder: string;
        term: bigint;
        acquired_at: Date;
        renewed_at: Date;
        expires_at: Date;
      }>
    >`
      INSERT INTO leader_leases (name, holder, term, acquired_at, renewed_at, expires_at)
      VALUES (
        ${name},
        ${this.instanceId},
        1,
        now(),
        now(),
        now() + make_interval(secs => ${this.ttlMs / 1000}::double precision)
      )
      ON CONFLICT (name) DO UPDATE SET
        holder = EXCLUDED.holder,
        term = CASE
          WHEN leader_leases.holder = EXCLUDED.holder THEN leader_leases.term
          ELSE leader_leases.term + 1
        END,
        acquired_at = CASE
          WHEN leader_leases.holder = EXCLUDED.holder THEN leader_leases.acquired_at
          ELSE now()
        END,
        renewed_at = now(),
        expires_at = EXCLUDED.expires_at
      WHERE leader_leases.expires_at < now() OR leader_leases.holder = EXCLUDED.holder
      RETURNING name, holder, term, acquired_at, renewed_at, expires_at
    `;
    this.metrics.leaseWait.observe({ loop: name }, (Date.now() - startedAt) / 1000);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      name: row.name,
      holder: row.holder,
      term: row.term,
      acquiredAt: row.acquired_at,
      renewedAt: row.renewed_at,
      expiresAt: row.expires_at,
    };
  }

  private async stepDown(state: CampaignState, reason: LeadershipLossReason): Promise<void> {
    state.leading = false;
    state.deadline = 0;
    this.metrics.leaderLease.set({ loop: state.name }, 0);
    this.metrics.leaderTransitions.inc({ loop: state.name, transition: 'lost' });
    this.logger.warn({ loop: state.name, reason }, 'Leadership lost');
    await this.safely(state, () => state.hooks.onLost(reason));
  }

  /**
   * A hook that throws must not take the renewal loop with it. Losing the loop
   * would leave the process holding a lease it is no longer acting on, which is
   * the one state worse than not holding it.
   */
  private async safely(state: CampaignState, run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error({ loop: state.name, err: error }, 'Leadership hook failed');
    }
  }
}
