import { Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  type KillSwitchState,
  TradingErrorCode,
  TradingState,
} from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { currentTenant, requireTenantId } from '@tp/tenancy';

// The states and their shape are the console's contract too: see shared-types.
export { TradingState, type KillSwitchState } from '@tp/shared-types';

/** The setting these rows live under. One name, no ambiguity about which. */
const KEY = 'trading';

/**
 * The cache key for the platform-wide halt, whose row has a null `tenantId`.
 *
 * A string rather than `null` because a Map keyed on `string | null` reads
 * badly at every use, and because a halt that applies to everybody deserves to
 * be named rather than represented by an absence.
 */
const PLATFORM = '__platform__';

/**
 * The global halt.
 *
 * One rule matters more than everything else here, and it is the reason the
 * switch is called a *halt* and not a freeze:
 *
 * **Closing is always allowed.** A halt stops new risk being taken on. It does
 * not trap traders in the risk they already hold. A switch that prevented closes
 * would, in the exact circumstances it exists for — a feed gone wrong, an engine
 * behaving oddly, a market nobody understands — leave every customer unable to
 * get out while the market moved against them. That is not a safety measure; it
 * is the thing safety measures exist to prevent.
 *
 * So: new orders refused, resting orders refused, modifications refused, closes
 * permitted. And the stop-out and protective-order engines keep running, because
 * an automatic close is still a close.
 */
@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger(KillSwitchService.name);

  /**
   * Cached, and refreshed on every change.
   *
   * The order path consults this on every submission, and a database round trip
   * per order to read a value that changes once a year is a cost paid a million
   * times for nothing. The cache is written by the same call that writes the
   * row, so within one process they cannot disagree; across processes a halt
   * propagates on the next refresh, which is why `refresh()` is called at boot
   * and the state is re-read whenever it is set.
   */
  private readonly cached = new Map<string, KillSwitchState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
  }

  /**
   * Re-reads every stored halt: each tenant's, and the platform's.
   *
   * One query rather than one per tenant. There are few of these rows — at most
   * one per tenant plus one — and reading them together means a process cannot
   * hold a halt for tenant A and a stale absence for tenant B.
   */
  async refresh(): Promise<void> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: KEY } });
    this.cached.clear();
    for (const row of rows) {
      const value = row.value as Partial<KillSwitchState> | null;
      this.cached.set(row.tenantId ?? PLATFORM, {
        state:
          value?.state === TradingState.DISABLED ? TradingState.DISABLED : TradingState.ENABLED,
        reason: value?.reason ?? null,
        changedAt: row.updatedAt.toISOString(),
        changedByUserId: row.updatedByUserId,
      });
    }
  }

  /**
   * The halt in force for the caller's tenant.
   *
   * **A platform-wide halt wins.** If the platform is halted, it does not matter
   * what a tenant has set: the reason the platform switch exists is that
   * something is wrong below the level any tenant can see, and a tenant being
   * able to trade through it would defeat it.
   */
  current(): KillSwitchState {
    const platform = this.cached.get(PLATFORM);
    if (platform?.state === TradingState.DISABLED) return platform;

    const tenant = currentTenant();
    const mine = tenant === undefined ? undefined : this.cached.get(tenant.tenantId);
    return mine ?? platform ?? ENABLED;
  }

  /**
   * Refuses an operation that would take on new risk.
   *
   * Called by order submission and modification, and deliberately **not** by any
   * close path. The name says what it guards so a future caller cannot mistake
   * it for a general "is trading allowed" check and quietly block a close with
   * it.
   */
  assertMayOpenRisk(): void {
    const state = this.current();
    if (state.state !== TradingState.DISABLED) return;
    throw new DomainError(
      TradingErrorCode.TRADING_HALTED,
      state.reason === null
        ? 'Trading is halted. Existing positions can still be closed.'
        : `Trading is halted: ${state.reason}. Existing positions can still be closed.`,
      { state: state.state },
    );
  }

  /**
   * Halts or resumes trading.
   *
   * Both directions are audited with the reason. "Who stopped trading, when, and
   * why" is the first question asked after any halt, and the second is "who
   * started it again" — an answer that exists only in somebody's memory is not
   * an answer.
   */
  async set(actorId: string, state: TradingState, reason: string | null): Promise<KillSwitchState> {
    /**
     * Halts the caller's own tenant, never the platform.
     *
     * The platform-wide row is read here and honoured, and there is deliberately
     * no route that writes it: halting every firm on the platform is not a
     * power that should sit behind the same permission as halting one's own.
     * It is set by whoever runs the platform, out of band, and until there is a
     * platform-operator role there is nothing here that could check for one.
     */
    const tenantId = requireTenantId();
    const before = this.current();
    const row = await this.prisma.systemSetting.upsert({
      where: { tenantId_key: { tenantId, key: KEY } },
      create: { key: KEY, tenantId, value: { state, reason }, updatedByUserId: actorId },
      update: { value: { state, reason }, updatedByUserId: actorId },
    });

    this.cached.set(tenantId, {
      state,
      reason,
      changedAt: row.updatedAt.toISOString(),
      changedByUserId: actorId,
    });

    if (state === TradingState.DISABLED) {
      this.logger.error({ actorId, reason }, 'TRADING HALTED. Closing remains available.');
    } else {
      this.logger.warn({ actorId }, 'Trading resumed.');
    }

    await this.audit.record({
      actorId,
      actorType: 'ADMIN',
      action: state === TradingState.DISABLED ? 'system.trading_halted' : 'system.trading_resumed',
      resourceType: 'System',
      resourceId: KEY,
      before: { state: before.state, reason: before.reason },
      after: { state, reason },
    });

    return this.current();
  }
}

const ENABLED: KillSwitchState = {
  state: TradingState.ENABLED,
  reason: null,
  changedAt: null,
  changedByUserId: null,
};
