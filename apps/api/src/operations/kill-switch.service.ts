import { Injectable, Logger } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';

export const TradingState = {
  ENABLED: 'TRADING_ENABLED',
  DISABLED: 'TRADING_DISABLED',
} as const;
export type TradingState = (typeof TradingState)[keyof typeof TradingState];

export interface KillSwitchState {
  state: TradingState;
  reason: string | null;
  changedAt: string | null;
  changedByUserId: string | null;
}

/** The single row this lives in. One switch, one name, no ambiguity about which. */
const KEY = 'trading';

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
  private cached: KillSwitchState = {
    state: TradingState.ENABLED,
    reason: null,
    changedAt: null,
    changedByUserId: null,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
  }

  /** Re-reads the stored state. Cheap, and safe to call often. */
  async refresh(): Promise<KillSwitchState> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: KEY } });
    if (row === null) return this.cached;
    const value = row.value as Partial<KillSwitchState> | null;
    this.cached = {
      state: value?.state === TradingState.DISABLED ? TradingState.DISABLED : TradingState.ENABLED,
      reason: value?.reason ?? null,
      changedAt: row.updatedAt.toISOString(),
      changedByUserId: row.updatedByUserId,
    };
    return this.cached;
  }

  current(): KillSwitchState {
    return this.cached;
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
    if (this.cached.state !== TradingState.DISABLED) return;
    throw new DomainError(
      TradingErrorCode.TRADING_HALTED,
      this.cached.reason === null
        ? 'Trading is halted. Existing positions can still be closed.'
        : `Trading is halted: ${this.cached.reason}. Existing positions can still be closed.`,
      { state: this.cached.state },
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
    const before = this.cached;
    const row = await this.prisma.systemSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: { state, reason }, updatedByUserId: actorId },
      update: { value: { state, reason }, updatedByUserId: actorId },
    });

    this.cached = {
      state,
      reason,
      changedAt: row.updatedAt.toISOString(),
      changedByUserId: actorId,
    };

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

    return this.cached;
  }
}
