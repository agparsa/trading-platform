import { Injectable } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { toDecimal } from '@tp/financial-core';
import {
  priceAlertObserved,
  priceAlertTriggered,
  type PriceAlertCondition,
  type PriceAlertSource,
} from '@tp/trading-core';
import type { PriceRange } from '@tp/trading-core';
import type { PriceAlert } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../common/audit/audit.service';
import { requireTenantId } from '@tp/tenancy';

export interface CreateAlertRequest {
  readonly symbol: string;
  readonly condition: PriceAlertCondition;
  readonly source?: PriceAlertSource;
  readonly price: string;
  readonly note?: string | null;
  readonly expiresAt?: Date | null;
}

/** How many active alerts one person may hold. */
export const MAX_ACTIVE_ALERTS_PER_USER = 200;

/**
 * Levels a trader asked to be told about.
 *
 * ## Why it is not part of the trigger engine
 *
 * They look alike — both watch a price and act when it is reached — but they
 * fail in opposite directions. A stop-loss that fires late costs money and one
 * that fires twice closes a position the trader still holds, so the engine is
 * built to be exactly once and to stop entirely when it cannot be sure. An
 * alert that arrives late is still useful and one that never arrives is a
 * nuisance. Putting them in one component would mean either the alerts
 * inheriting the engine's caution — silence during any incident — or the engine
 * inheriting the alerts' tolerance, which is not a trade anyone should make.
 *
 * ## Firing exactly once
 *
 * The write is a conditional update on `status = ACTIVE`. Two instances
 * evaluating the same tick therefore produce one notification: the second
 * update matches no rows and the second instance sends nothing. That is
 * deliberate belt-and-braces — evaluation runs under a lease, so there should
 * not be a second instance, and "should not" is not a thing to notify a trader
 * on the strength of.
 */
@Injectable()
export class PriceAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly symbols: SymbolsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async create(userId: string, request: CreateAlertRequest): Promise<PriceAlert> {
    const symbol = request.symbol.toUpperCase();
    // Throws if the instrument is unknown, which is the right answer: an alert
    // on a symbol that does not exist would wait for ever and look active.
    this.symbols.require(symbol);

    const price = toDecimal(request.price);
    if (!price.isFinite() || price.lessThanOrEqualTo(0)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A price alert needs a positive level',
        {
          price: request.price,
        },
      );
    }
    if (request.expiresAt !== null && request.expiresAt !== undefined) {
      if (request.expiresAt.getTime() <= Date.now()) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          'An alert cannot expire in the past',
          { expiresAt: request.expiresAt.toISOString() },
        );
      }
    }

    /**
     * A ceiling per person, checked here rather than left to the database.
     *
     * The sweep reads every active alert on an instrument on every tick. One
     * account with fifty thousand alerts on XAUUSD is not that person's problem
     * — it is everybody's, because it is the tick path.
     */
    const active = await this.prisma.priceAlert.count({ where: { userId, status: 'ACTIVE' } });
    if (active >= MAX_ACTIVE_ALERTS_PER_USER) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `An account may hold ${MAX_ACTIVE_ALERTS_PER_USER} active alerts`,
        { active },
      );
    }

    const alert = await this.prisma.priceAlert.create({
      data: {
        tenantId: requireTenantId(),
        userId,
        symbol,
        condition: request.condition,
        source: request.source ?? 'BID',
        price: price.toString(),
        note: request.note ?? null,
        expiresAt: request.expiresAt ?? null,
      },
    });
    return alert;
  }

  async list(userId: string, status?: PriceAlert['status']): Promise<readonly PriceAlert[]> {
    return this.prisma.priceAlert.findMany({
      where: { userId, ...(status === undefined ? {} : { status }) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  /**
   * Cancel an alert.
   *
   * A conditional update rather than a read-then-write, and scoped to the owner
   * in the same statement: an alert id is a UUID a person might paste, and
   * "cancel by id" that trusts the id is how one trader silences another's.
   */
  async cancel(userId: string, id: string): Promise<PriceAlert> {
    const { count } = await this.prisma.priceAlert.updateMany({
      where: { id, userId, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No active alert with that id', {
        id,
      });
    }
    return this.prisma.priceAlert.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Everything watching this instrument, for one evaluation pass.
   *
   * Read inside the tenant it belongs to by the caller; this is the query, not
   * the scoping.
   */
  async activeFor(symbol: string): Promise<readonly PriceAlert[]> {
    return this.prisma.priceAlert.findMany({ where: { symbol, status: 'ACTIVE' } });
  }

  /**
   * Decide one alert against everything the market printed, and tell the trader
   * if it is time.
   *
   * Returns whether it fired, so a caller can count. An alert past its expiry
   * is retired rather than fired: a trader who said "tell me before Friday"
   * does not want to hear about it on Monday, and leaving it ACTIVE would mean
   * the sweep reads it on every tick for ever.
   */
  async evaluate(
    alert: PriceAlert,
    range: PriceRange,
    latest: { readonly bid: string; readonly ask: string },
    nowMs: number = Date.now(),
  ): Promise<boolean> {
    if (alert.expiresAt !== null && alert.expiresAt.getTime() <= nowMs) {
      await this.prisma.priceAlert.updateMany({
        where: { id: alert.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
      return false;
    }

    const level = {
      condition: alert.condition,
      source: alert.source,
      price: alert.price.toString(),
    };
    if (!priceAlertTriggered(level, range)) return false;

    const observed = priceAlertObserved(alert.source, latest);

    /**
     * The claim on the alert and the notification are separate steps, in this
     * order, deliberately.
     *
     * If the claim succeeds and the notification then fails, the trader misses
     * one alert — bad. If the notification were sent first and the claim then
     * failed, the trader would get an alert per tick until the write succeeded
     * — worse, and much harder to stop once it starts.
     */
    const { count } = await this.prisma.priceAlert.updateMany({
      where: { id: alert.id, status: 'ACTIVE' },
      data: {
        status: 'TRIGGERED',
        triggeredAt: new Date(nowMs),
        triggeredPrice: observed,
      },
    });
    if (count === 0) return false;

    await this.notifications.raise({
      userId: alert.userId,
      kind: 'price.alert',
      severity: 'INFO',
      title: `${alert.symbol} ${alert.condition === 'ABOVE' ? 'reached' : 'fell to'} ${alert.price.toString()}`,
      body:
        alert.note === null || alert.note.length === 0
          ? `${alert.symbol} is at ${observed}.`
          : `${alert.symbol} is at ${observed}. ${alert.note}`,
      data: {
        alertId: alert.id,
        symbol: alert.symbol,
        condition: alert.condition,
        source: alert.source,
        level: alert.price.toString(),
        observed,
      },
      // One alert, one notice, however many producers noticed it.
      dedupeKey: `price-alert:${alert.id}`,
    });

    await this.audit.record({
      actorType: 'SYSTEM',
      actorId: null,
      action: 'PRICE_ALERT_TRIGGERED',
      resourceType: 'PriceAlert',
      resourceId: alert.id,
      after: {
        userId: alert.userId,
        symbol: alert.symbol,
        condition: alert.condition,
        level: alert.price.toString(),
        observed,
      },
    });
    return true;
  }
}
