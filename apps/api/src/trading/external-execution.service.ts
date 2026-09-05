import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Account, Prisma } from '@prisma/client';
import {
  BrokerAdapterError,
  capabilityForOrderType,
  type BrokerCapabilities,
  type NormalisedOrder,
  type OrderResult as VenueResult,
} from '@tp/broker-sdk';
import {
  DomainError,
  DomainEvent,
  OrderStatus,
  TradingErrorCode,
  type OrderSide,
  type OrderType,
} from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import { BrokerConnectionsService } from '../broker-connections/broker-connections.service';
import { BrokerMappingService } from '../broker-connections/broker-mapping.service';
import { AuditService } from '../common/audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from '../realtime/events.service';

export interface ExternalOrderRequest {
  readonly account: Account;
  readonly symbolId: string;
  readonly symbolCode: string;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly volume: string;
  readonly price: string | null;
  readonly stopPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
  readonly userId: string;
}

export interface ExternalOrderOutcome {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly status: OrderStatus;
  readonly externalOrderId: string | null;
  readonly externalPositionId: string | null;
  readonly filledVolume: string;
  readonly averagePrice: string | null;
  readonly reason: string | null;
}

/**
 * Orders for accounts that execute at a venue.
 *
 * ## Why this is not a branch inside `OrdersService`
 *
 * The internal path's correctness rests on one transaction: risk is evaluated
 * under the account's lock and the margin is spent before the lock is
 * released, so two orders cannot both fit into the same free margin. A
 * network call cannot go inside that transaction — a venue that takes four
 * seconds would hold the account's row for four seconds, and a venue that
 * never answers would hold it for ever.
 *
 * So the external path is a different shape, and it lives in a different
 * class so that reading either one shows the whole of it:
 *
 * ```
 *   record the order (ACCEPTED, with our clientOrderId)   ← transaction 1
 *   send it to the venue                                  ← no transaction
 *   record what the venue did                             ← transaction 2
 * ```
 *
 * The order row exists **before** the request leaves. That ordering is the
 * whole recovery story: if this process dies mid-flight, there is a row
 * saying "we sent this, with this id", and the venue can be asked about it.
 * The other ordering — send, then record — loses the order entirely, and the
 * position it opened becomes one nobody on this side knows about.
 *
 * ## UNKNOWN is a state, not an exception
 *
 * If the venue does not answer, the order becomes `UNCONFIRMED` and
 * `resolveUnconfirmed` asks the venue with the same `clientOrderId`. Nothing
 * ever resends: the venue may have filled the first one, and a duplicate
 * position is worse than a delayed answer. §41, §26.
 *
 * ## What it does not do yet
 *
 * It does not post to the ledger. An externally executed fill is money at a
 * venue, not in this platform's own books, and reconciling the two is phase 9
 * — deliberately not guessed at here. The order, execution and position rows
 * carry the venue's ids so that reconciliation has something to join on.
 */
@Injectable()
export class ExternalExecutionService {
  private readonly logger = new Logger(ExternalExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: BrokerConnectionsService,
    private readonly mappings: BrokerMappingService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly outbox: OutboxService,
  ) {}

  /** True when this account's orders belong to a venue rather than the engine. */
  static isExternal(account: Pick<Account, 'executionMode' | 'brokerConnectionId'>): boolean {
    return account.executionMode === 'EXTERNAL_BROKER' && account.brokerConnectionId !== null;
  }

  async place(request: ExternalOrderRequest): Promise<ExternalOrderOutcome> {
    const connectionId = request.account.brokerConnectionId;
    if (connectionId === null) {
      throw new DomainError(
        TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
        'This account executes externally and names no venue connection.',
        { accountId: request.account.id },
      );
    }
    const externalAccountId = request.account.externalAccountId;
    if (externalAccountId === null) {
      throw new DomainError(
        TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
        'This account has no identity at the venue yet. Map it before trading it there.',
        { accountId: request.account.id },
      );
    }

    const externalSymbol = await this.mappings.requireExternalSymbol(
      connectionId,
      request.symbolCode,
    );
    const capabilities = await this.capabilitiesOf(connectionId);
    const needed = capabilityForOrderType(request.type);
    if (capabilities !== null && capabilities[needed] !== true) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `This venue does not take ${request.type} orders.`,
        { venue: connectionId, orderType: request.type },
      );
    }

    // The row before the request. See the class comment: this ordering is the
    // recovery story.
    const clientOrderId = `tp-${randomUUID()}`;
    const order = await this.prisma.order.create({
      data: {
        tenantId: requireTenantId(),
        accountId: request.account.id,
        symbolId: request.symbolId,
        side: request.side,
        type: request.type,
        status: OrderStatus.ACCEPTED,
        timeInForce: request.type === 'MARKET' ? 'IOC' : 'GTC',
        volume: request.volume,
        filledVolume: '0',
        price: request.price,
        stopPrice: request.stopPrice,
        stopLoss: request.stopLoss,
        takeProfit: request.takeProfit,
        clientOrderId,
      },
    });
    await this.prisma.orderEvent.createMany({
      data: [
        {
          tenantId: requireTenantId(),
          orderId: order.id,
          type: 'CREATED',
          toStatus: OrderStatus.NEW,
          payload: { volume: request.volume, venue: connectionId, clientOrderId },
        },
        {
          tenantId: requireTenantId(),
          orderId: order.id,
          type: 'ACCEPTED',
          fromStatus: OrderStatus.NEW,
          toStatus: OrderStatus.ACCEPTED,
          payload: { externalSymbol, externalAccountId },
        },
      ],
    });

    const normalised: NormalisedOrder = {
      clientOrderId,
      externalAccountId,
      externalSymbol,
      side: request.side,
      type: request.type,
      volume: request.volume,
      price: request.price,
      stopPrice: request.stopPrice,
      stopLoss: request.stopLoss,
      takeProfit: request.takeProfit,
      timeInForce: request.type === 'MARKET' ? 'IOC' : 'GTC',
    };

    let result: VenueResult;
    try {
      result = await this.connections.withAdapter(connectionId, (adapter) =>
        adapter.placeOrder(normalised),
      );
    } catch (error) {
      /**
       * The venue refused to take it, or the connection is down. This is the
       * one case where nothing may have reached the venue *and* nothing may
       * have left it — so the order is recorded as UNCONFIRMED rather than
       * rejected: the recovery query will settle it. Being wrong in the safe
       * direction here means one query; being wrong in the other means a
       * position nobody knows about.
       */
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof BrokerAdapterError ? error.code : 'VENUE_ERROR';
      this.logger.warn(
        { orderId: order.id, clientOrderId, code },
        'A venue did not answer an order; it is unconfirmed until the venue is asked',
      );
      return this.recordUnconfirmed(order.id, request, `${code}: ${message}`);
    }

    return this.applyResult(order.id, request, result);
  }

  /**
   * Ask the venue what became of an order whose answer was lost.
   *
   * Called by the recovery sweep and by a person from the console. It asks;
   * it never resends. A `null` answer means the venue never saw the order,
   * which is the only state in which it is safe to say nothing happened.
   */
  async resolveUnconfirmed(orderId: string): Promise<ExternalOrderOutcome | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, status: OrderStatus.UNCONFIRMED },
      include: { account: true, symbol: { select: { code: true } } },
    });
    if (order === null) return null;
    const connectionId = order.account.brokerConnectionId;
    if (order.clientOrderId === null || connectionId === null) return null;

    const found = await this.connections.withAdapter(connectionId, (adapter) =>
      adapter.queryOrder(order.clientOrderId as string),
    );

    const request: ExternalOrderRequest = {
      account: order.account,
      symbolId: order.symbolId,
      symbolCode: order.symbol.code,
      side: order.side,
      type: order.type,
      volume: order.volume.toString(),
      price: order.price?.toString() ?? null,
      stopPrice: order.stopPrice?.toString() ?? null,
      stopLoss: order.stopLoss?.toString() ?? null,
      takeProfit: order.takeProfit?.toString() ?? null,
      userId: order.account.userId,
    };

    if (found === null) {
      /**
       * The venue never saw it. The order is cancelled — not resent. Whether
       * to try again is the trader's decision with fresh prices, not this
       * method's with stale ones.
       */
      await this.prisma.order.updateMany({
        where: { id: order.id, status: OrderStatus.UNCONFIRMED },
        data: { status: OrderStatus.CANCELLED, rejectionCode: 'VENUE_NEVER_RECEIVED' },
      });
      await this.recordEvent(order.id, 'CANCELLED', OrderStatus.UNCONFIRMED, OrderStatus.CANCELLED, {
        reason: 'the venue has no record of this order',
      });
      await this.audit.record({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'order.unconfirmed_resolved',
        resourceType: 'Order',
        resourceId: order.id,
        after: { outcome: 'never received', clientOrderId: order.clientOrderId },
      });
      return {
        orderId: order.id,
        clientOrderId: order.clientOrderId,
        status: OrderStatus.CANCELLED,
        externalOrderId: null,
        externalPositionId: null,
        filledVolume: '0',
        averagePrice: null,
        reason: 'the venue has no record of this order',
      };
    }

    this.logger.log(
      { orderId: order.id, outcome: found.outcome },
      'An unconfirmed order was resolved by asking the venue',
    );
    return this.applyResult(order.id, request, found, OrderStatus.UNCONFIRMED);
  }

  /** Every order still waiting on a venue's answer, oldest first. */
  async unconfirmed(limit = 100): Promise<readonly { id: string; clientOrderId: string | null; accountId: string; createdAt: Date }[]> {
    return this.prisma.order.findMany({
      where: { status: OrderStatus.UNCONFIRMED },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, clientOrderId: true, accountId: true, createdAt: true },
    });
  }

  private async applyResult(
    orderId: string,
    request: ExternalOrderRequest,
    result: VenueResult,
    from: OrderStatus = OrderStatus.ACCEPTED,
  ): Promise<ExternalOrderOutcome> {
    if (result.outcome === 'UNKNOWN') {
      return this.recordUnconfirmed(orderId, request, result.reason ?? 'no answer from the venue');
    }
    if (result.outcome === 'REJECTED') {
      await this.prisma.order.updateMany({
        where: { id: orderId },
        data: { status: OrderStatus.REJECTED, rejectionCode: 'VENUE_REJECTED' },
      });
      await this.recordEvent(orderId, 'REJECTED', from, OrderStatus.REJECTED, {
        reason: result.reason,
      });
      await this.events.publish(DomainEvent.ORDER_REJECTED, request.account.id, {
        orderId,
        symbol: request.symbolCode,
        // The venue's own words, for staff. The trader is shown the platform's.
        reason: result.reason ?? 'the venue rejected this order',
      });
      return {
        orderId,
        clientOrderId: result.clientOrderId,
        status: OrderStatus.REJECTED,
        externalOrderId: result.externalOrderId,
        externalPositionId: null,
        filledVolume: '0',
        averagePrice: null,
        reason: result.reason,
      };
    }

    if (result.outcome === 'ACCEPTED') {
      // Working at the venue: a limit or stop that has not traded. Its fills
      // arrive as events, through the inbox.
      await this.prisma.order.updateMany({
        where: { id: orderId },
        data: { externalOrderId: result.externalOrderId },
      });
      return {
        orderId,
        clientOrderId: result.clientOrderId,
        status: OrderStatus.ACCEPTED,
        externalOrderId: result.externalOrderId,
        externalPositionId: null,
        filledVolume: '0',
        averagePrice: null,
        reason: null,
      };
    }

    // FILLED or PARTIALLY_FILLED.
    const filledVolume = sumVolume(result.fills.map((fill) => fill.volume));
    const averagePrice = weightedAverage(result.fills);
    const status =
      result.outcome === 'FILLED' ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;

    const recorded = await this.prisma.$transaction(async (tx) => {
      await tx.order.updateMany({
        where: { id: orderId },
        data: {
          status,
          filledVolume,
          externalOrderId: result.externalOrderId,
        },
      });
      for (const fill of result.fills) {
        /**
         * Keyed by the venue's own execution id, which is unique in the
         * database. A redelivered fill — the same event arriving twice — is
         * refused there rather than booked twice, which is the whole reason
         * the column exists.
         */
        await tx.execution.create({
          data: {
            tenantId: requireTenantId(),
            orderId,
            accountId: request.account.id,
            side: request.side,
            volume: fill.volume,
            price: fill.price,
            externalExecutionId: fill.externalExecutionId,
            // The venue does not tell us its book; what it filled at is the
            // only price there is, and recording it as both sides is honest
            // about that rather than inventing a spread.
            quoteBid: fill.price,
            quoteAsk: fill.price,
            quoteAt: fill.at,
          },
        });
      }

      let positionId: string | null = null;
      if (result.externalPositionId !== null && averagePrice !== null) {
        const position = await tx.position.create({
          data: {
            tenantId: requireTenantId(),
            accountId: request.account.id,
            symbolId: request.symbolId,
            status: 'OPEN',
            side: request.side,
            volume: filledVolume,
            initialVolume: filledVolume,
            entryPrice: averagePrice,
            // Margin, commission and swap are the venue's at a venue-executed
            // account. Zero here is not a claim that they are free; it is this
            // platform not inventing figures it was not told. Reconciliation
            // (phase 9) is where the venue's own numbers arrive.
            margin: '0',
            commission: '0',
            swap: '0',
            realizedPnl: '0',
            stopLoss: request.stopLoss,
            takeProfit: request.takeProfit,
            externalPositionId: result.externalPositionId,
          },
        });
        positionId = position.id;
        await tx.order.updateMany({ where: { id: orderId }, data: { positionId } });
        await tx.positionEvent.create({
          data: {
            tenantId: requireTenantId(),
            positionId,
            type: 'OPENED',
            toStatus: 'OPEN',
            payload: {
              externalPositionId: result.externalPositionId,
              volume: filledVolume,
              entryPrice: averagePrice,
              venue: request.account.brokerConnectionId,
            },
          },
        });
      }

      await tx.orderEvent.create({
        data: {
          tenantId: requireTenantId(),
          orderId,
          type: 'FILLED',
          fromStatus: from,
          toStatus: status,
          payload: {
            volume: filledVolume,
            price: averagePrice,
            externalOrderId: result.externalOrderId,
          },
        },
      });

      const payload = {
        orderId,
        positionId,
        symbol: request.symbolCode,
        side: request.side,
        volume: filledVolume,
        price: averagePrice,
        venue: request.account.brokerConnectionId,
        externalOrderId: result.externalOrderId,
      };
      const event = await this.outbox.record(
        tx,
        DomainEvent.ORDER_FILLED,
        request.account.id,
        payload,
      );
      return { positionId, payload, eventId: event.eventId };
    });

    await this.events.publish(DomainEvent.ORDER_FILLED, request.account.id, recorded.payload, {
      eventId: recorded.eventId,
    });
    if (recorded.positionId !== null) {
      await this.events.publish(DomainEvent.POSITION_OPENED, request.account.id, {
        positionId: recorded.positionId,
        symbol: request.symbolCode,
        side: request.side,
        volume: filledVolume,
        entryPrice: averagePrice,
      });
    }

    return {
      orderId,
      clientOrderId: result.clientOrderId,
      status,
      externalOrderId: result.externalOrderId,
      externalPositionId: result.externalPositionId,
      filledVolume,
      averagePrice,
      reason: null,
    };
  }

  private async recordUnconfirmed(
    orderId: string,
    request: ExternalOrderRequest,
    reason: string,
  ): Promise<ExternalOrderOutcome> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId },
      select: { clientOrderId: true, status: true },
    });
    if (order?.status !== OrderStatus.UNCONFIRMED) {
      await this.prisma.order.updateMany({
        where: { id: orderId, status: OrderStatus.ACCEPTED },
        data: { status: OrderStatus.UNCONFIRMED },
      });
      await this.recordEvent(
        orderId,
        'REJECTED',
        OrderStatus.ACCEPTED,
        OrderStatus.UNCONFIRMED,
        { reason },
      );
    }
    await this.audit.record({
      actorId: request.userId,
      actorType: 'USER',
      action: 'order.unconfirmed',
      resourceType: 'Order',
      resourceId: orderId,
      after: { reason, symbol: request.symbolCode, volume: request.volume },
    });
    return {
      orderId,
      clientOrderId: order?.clientOrderId ?? '',
      status: OrderStatus.UNCONFIRMED,
      externalOrderId: null,
      externalPositionId: null,
      filledVolume: '0',
      averagePrice: null,
      reason,
    };
  }

  private async recordEvent(
    orderId: string,
    type: string,
    from: OrderStatus,
    to: OrderStatus,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.orderEvent.create({
      data: {
        tenantId: requireTenantId(),
        orderId,
        type: type as never,
        fromStatus: from,
        toStatus: to,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private async capabilitiesOf(connectionId: string): Promise<BrokerCapabilities | null> {
    const connection = await this.prisma.brokerConnection.findFirst({
      where: { id: connectionId },
      select: { capabilities: true },
    });
    return (connection?.capabilities as BrokerCapabilities | null) ?? null;
  }
}

/** Exact decimal addition over fill volumes. No float touches a volume. */
export function sumVolume(volumes: readonly string[]): string {
  const scale = 8;
  const toInt = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.');
    const negative = whole.startsWith('-');
    const digits = (negative ? whole.slice(1) : whole) + fraction.padEnd(scale, '0').slice(0, scale);
    const magnitude = BigInt(digits === '' ? '0' : digits);
    return negative ? -magnitude : magnitude;
  };
  const total = volumes.reduce((sum, value) => sum + toInt(value), 0n);
  if (total === 0n) return '0';
  const text = total.toString().padStart(scale + 1, '0');
  const whole = text.slice(0, -scale);
  const fraction = text.slice(-scale).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/**
 * Volume-weighted average fill price, to ten decimals.
 *
 * Not the arithmetic mean: two fills of 0.9 and 0.1 lots at different prices
 * do not average to the midpoint, and a trader shown the midpoint would be
 * shown a price nothing traded at.
 */
export function weightedAverage(
  fills: readonly { volume: string; price: string }[],
): string | null {
  if (fills.length === 0) return null;
  const scale = 10n;
  const factor = 10n ** scale;
  const toInt = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(Number(scale), '0').slice(0, Number(scale)));
  };
  let weighted = 0n;
  let total = 0n;
  for (const fill of fills) {
    const volume = toInt(fill.volume);
    weighted += volume * toInt(fill.price);
    total += volume;
  }
  if (total === 0n) return null;
  const average = weighted / total;
  const text = average.toString().padStart(Number(scale) + 1, '0');
  const whole = text.slice(0, -Number(scale));
  const fraction = text.slice(-Number(scale)).replace(/0+$/, '');
  void factor;
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}
