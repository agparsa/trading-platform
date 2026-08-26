import { Injectable, Logger } from '@nestjs/common';
import {
  checkVolume,
  commissionForLeg,
  entryPriceFor,
  Money,
  normalizePrice,
  normalizeVolume,
  requiredMargin,
  notionalValue,
  toDecimal,
} from '@tp/financial-core';
import { transitionOrder, validatePendingPrice, validateProtectiveLevels } from '@tp/trading-core';
import { DEFAULT_RISK_RULES, RiskEngine, type ProposedOrder } from '@tp/risk-core';
import {
  DomainError,
  DomainEvent,
  type OrderSide,
  OrderStatus,
  TradingErrorCode,
} from '@tp/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from '../market/quote.service';
import { ConversionService } from '../market/conversion.service';
import { LedgerService } from '../accounts/ledger.service';
import { MetricsService } from '../metrics/metrics.service';
import { AuditService } from '../common/audit/audit.service';
import { EventsService } from '../realtime/events.service';
import { endOfTradingDay, isSessionOpen } from '../market/session';
import { AccountStateService } from './account-state.service';
import { RiskContextBuilder } from './risk-context.builder';
import type {
  ModifyPendingRequest,
  OpenPositionRequest,
  OrderResult,
  PendingOrderResult,
  PlacePendingRequest,
} from './trading.types';
import type { Tick } from '@tp/market-core';
import { ConfigService } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import type { Env } from '../config/env.schema';

/**
 * Market-order submission.
 *
 * The ordering below is not arbitrary. Everything that can reject — validation,
 * pricing, margin, risk — happens *before* the transaction opens, so a rejected
 * order costs one read-only pass and holds no row locks. The transaction only
 * contains writes that must succeed or fail together.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly risk = new RiskEngine(DEFAULT_RISK_RULES);

  constructor(
    private readonly prisma: PrismaService,
    private readonly symbols: SymbolsService,
    private readonly quotes: QuoteService,
    private readonly conversion: ConversionService,
    private readonly accountState: AccountStateService,
    private readonly riskContext: RiskContextBuilder,
    private readonly ledger: LedgerService,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  async openPosition(userId: string, request: OpenPositionRequest): Promise<OrderResult> {
    const now = Date.now();
    const symbolCode = request.symbol.toUpperCase();
    const instrument = this.symbols.require(symbolCode);
    const spec = instrument.spec;

    const account = await this.prisma.account.findFirst({
      where: { id: request.accountId, userId },
    });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId: request.accountId,
      });
    }
    if (account.status !== 'ACTIVE') {
      throw new DomainError(
        TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
        `This account is ${account.status.toLowerCase()} and cannot open positions`,
        { status: account.status },
      );
    }

    if (!isSessionOpen(instrument.session, now)) {
      throw new DomainError(
        TradingErrorCode.MARKET_CLOSED,
        `${symbolCode} is outside its trading session`,
        {
          symbol: symbolCode,
        },
      );
    }

    // Snap the requested volume down to the lot grid, then validate. Rounding
    // up would hand the trader more risk than they asked for.
    const volume = normalizeVolume(spec, request.volume);
    const volumeCheck = checkVolume(spec, volume);
    if (!volumeCheck.ok) {
      throw new DomainError(
        TradingErrorCode.INVALID_VOLUME,
        `Volume ${request.volume} is not tradeable for ${symbolCode} (${volumeCheck.reason})`,
        {
          requested: request.volume,
          min: spec.minVolume,
          max: spec.maxVolume,
          step: spec.volumeStep,
        },
      );
    }

    const tick = await this.quotes.requireFresh(symbolCode, now);
    const entryPrice = normalizePrice(spec, entryPriceFor(request.side, tick));

    validateProtectiveLevels(spec, request.side, entryPrice.toString(), {
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
    });

    const rate = await this.conversion.rate(spec.quoteCurrency, account.currency);
    const margin = requiredMargin({
      spec,
      volume,
      price: entryPrice,
      accountLeverage: account.leverage,
      accountCurrency: account.currency,
      quoteToAccountRate: rate,
    });
    const notional = Money.of(
      notionalValue(spec, volume, entryPrice),
      spec.quoteCurrency,
    ).convertTo(account.currency, rate);
    const commission = commissionForLeg(spec, volume, account.currency, rate);

    const valuation = await this.accountState.valuate(account.id);
    const context = await this.riskContext.build(valuation, now);
    const proposed: ProposedOrder = {
      symbol: symbolCode,
      spec,
      side: request.side,
      volume: volume.toString(),
      price: entryPrice.toString(),
      requiredMargin: margin,
      notional,
    };

    const decision = this.risk.evaluate(proposed, context);
    if (!decision.allowed) {
      const first = decision.violations[0];
      await this.recordRiskEvent(account.id, decision.violations, valuation);
      this.metrics.ordersSubmitted.inc({ symbol: symbolCode, type: 'MARKET', outcome: 'rejected' });
      throw new DomainError(
        first?.code ?? TradingErrorCode.VALIDATION_FAILED,
        first?.message ?? 'Order rejected by risk',
        {
          // Every violation is reported, not just the first, so a trader fixes
          // all of them in one attempt.
          violations: decision.violations.map((v) => `${v.rule}: ${v.message}`).join('; '),
        },
      );
    }

    const symbolId = this.symbols.requireId(symbolCode);

    const result = await this.prisma.$transaction(async (tx) => {
      // First statement, deliberately. Inserting the order takes a share lock on
      // this account row and the ledger post later wants it exclusively; two
      // concurrent orders would deadlock on that pair. See LedgerService.lockAccount.
      await this.ledger.lockAccount(tx, account.id);

      const order = await tx.order.create({
        data: {
          accountId: account.id,
          symbolId,
          side: request.side,
          type: 'MARKET',
          status: OrderStatus.FILLED,
          timeInForce: 'IOC',
          volume: volume.toString(),
          filledVolume: volume.toString(),
          stopLoss: request.stopLoss ?? null,
          takeProfit: request.takeProfit ?? null,
        },
      });

      // The full lifecycle is recorded even though a market order traverses it
      // in one step: the audit trail must show the same shape for every order.
      await tx.orderEvent.createMany({
        data: [
          {
            orderId: order.id,
            type: 'CREATED',
            toStatus: OrderStatus.NEW,
            payload: { volume: volume.toString() },
          },
          {
            orderId: order.id,
            type: 'ACCEPTED',
            fromStatus: OrderStatus.NEW,
            toStatus: OrderStatus.ACCEPTED,
          },
          {
            orderId: order.id,
            type: 'FILLED',
            fromStatus: OrderStatus.ACCEPTED,
            toStatus: OrderStatus.FILLED,
            payload: { price: entryPrice.toString(), bid: tick.bid, ask: tick.ask },
          },
        ],
      });

      await tx.execution.create({
        data: {
          orderId: order.id,
          accountId: account.id,
          side: request.side,
          volume: volume.toString(),
          price: entryPrice.toString(),
          quoteBid: tick.bid,
          quoteAsk: tick.ask,
          quoteAt: new Date(tick.timestamp),
        },
      });

      const position = await this.openPositionForOrder(tx, {
        orderId: order.id,
        accountId: account.id,
        symbolId,
        symbolCode,
        side: request.side,
        volume: volume.toString(),
        entryPrice: entryPrice.toString(),
        stopLoss: request.stopLoss ?? null,
        takeProfit: request.takeProfit ?? null,
        margin,
        commission,
      });

      return { order, position };
    });

    this.metrics.ordersSubmitted.inc({ symbol: symbolCode, type: 'MARKET', outcome: 'filled' });

    // Published after the transaction commits, never inside it. A subscriber
    // must not be told about a fill that a rollback is about to erase.
    await this.events.publish(DomainEvent.ORDER_FILLED, account.id, {
      orderId: result.order.id,
      symbol: symbolCode,
      side: request.side,
      volume: volume.toString(),
      price: entryPrice.toString(),
    });
    await this.events.publish(DomainEvent.POSITION_OPENED, account.id, {
      positionId: result.position.id,
      symbol: symbolCode,
      side: request.side,
      volume: volume.toString(),
      entryPrice: entryPrice.toString(),
      margin: margin.toString(),
    });
    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'ORDER_CREATE',
      resourceType: 'Order',
      resourceId: result.order.id,
      after: {
        symbol: symbolCode,
        side: request.side,
        volume: volume.toString(),
        price: entryPrice.toString(),
        positionId: result.position.id,
      },
    });

    return {
      orderId: result.order.id,
      positionId: result.position.id,
      status: OrderStatus.FILLED,
      symbol: symbolCode,
      side: request.side,
      volume: volume.toString(),
      price: entryPrice.toString(),
      executedAt: result.order.createdAt.toISOString(),
    };
  }

  /**
   * Everything an opening fill does once its order row exists.
   *
   * Shared by market orders and by resting orders that trigger, so there is one
   * definition of what opening a position means. Two paths that each built a
   * position would eventually disagree about commission, margin or the event
   * trail, and the disagreement would only surface in a dispute.
   */
  private async openPositionForOrder(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      accountId: string;
      symbolId: string;
      symbolCode: string;
      side: OrderSide;
      volume: string;
      entryPrice: string;
      stopLoss: string | null;
      takeProfit: string | null;
      margin: Money;
      commission: Money;
    },
  ) {
    const position = await tx.position.create({
      data: {
        accountId: params.accountId,
        symbolId: params.symbolId,
        side: params.side,
        status: 'OPEN',
        volume: params.volume,
        initialVolume: params.volume,
        entryPrice: params.entryPrice,
        currentPrice: params.entryPrice,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        margin: params.margin.toString(),
        commission: params.commission.toString(),
      },
    });

    await tx.order.update({ where: { id: params.orderId }, data: { positionId: position.id } });
    await tx.positionEvent.create({
      data: {
        positionId: position.id,
        type: 'OPENED',
        toStatus: 'OPEN',
        payload: {
          entryPrice: params.entryPrice,
          volume: params.volume,
          margin: params.margin.toString(),
        },
      },
    });

    // Commission is realized at open, so it belongs in the ledger now — not
    // folded into floating P&L, where it would be counted twice.
    if (params.commission.isPositive()) {
      await this.ledger.post(tx, {
        accountId: params.accountId,
        type: 'COMMISSION',
        amount: params.commission.negated(),
        referenceType: 'Position',
        referenceId: position.id,
        idempotencyKey: `commission:open:${position.id}`,
        description: `Commission on opening ${params.symbolCode}`,
      });
    }

    return position;
  }

  // -------------------------------------------------------------------------
  // Resting orders — LIMIT and STOP
  // -------------------------------------------------------------------------

  /**
   * Place a resting order.
   *
   * No margin is reserved. That is the conventional model and the honest one:
   * an order that may never fill should not tie up buying power for a week, and
   * reserving margin at placement would mean maintaining a second, parallel
   * definition of used margin that the account valuation knows nothing about.
   * The consequence is that risk has to be re-evaluated when the order fires —
   * which is exactly what `fillPending` does, and where the answer matters.
   *
   * A fresh quote is required even though nothing executes yet. Without a market
   * price there is no way to tell a real resting order from a mistyped one that
   * would fire on the next tick, and accepting both would turn a typo into a
   * market order at a price the trader never chose.
   */
  async placePending(userId: string, request: PlacePendingRequest): Promise<PendingOrderResult> {
    const now = Date.now();
    const symbolCode = request.symbol.toUpperCase();
    const instrument = this.symbols.require(symbolCode);
    const spec = instrument.spec;

    const account = await this.prisma.account.findFirst({
      where: { id: request.accountId, userId },
    });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId: request.accountId,
      });
    }
    if (account.status !== 'ACTIVE') {
      throw new DomainError(
        TradingErrorCode.ACCOUNT_NOT_TRADEABLE,
        `This account is ${account.status.toLowerCase()} and cannot place orders`,
        { status: account.status },
      );
    }

    const volume = normalizeVolume(spec, request.volume);
    const volumeCheck = checkVolume(spec, volume);
    if (!volumeCheck.ok) {
      throw new DomainError(
        TradingErrorCode.INVALID_VOLUME,
        `Volume ${request.volume} is not tradeable for ${symbolCode} (${volumeCheck.reason})`,
        {
          requested: request.volume,
          min: spec.minVolume,
          max: spec.maxVolume,
          step: spec.volumeStep,
        },
      );
    }

    const tick = await this.quotes.requireFresh(symbolCode, now);
    validatePendingPrice(spec, request.type, request.side, request.price, tick);

    // Protective levels are measured against the resting price, not the market.
    // The order will open at roughly where it rests, so that is the reference a
    // stop-loss has to sit the right side of; validating against today's market
    // would accept a stop that is nonsense by the time the order fills.
    validateProtectiveLevels(spec, request.side, request.price, {
      stopLoss: request.stopLoss ?? null,
      takeProfit: request.takeProfit ?? null,
    });

    const timeInForce = request.timeInForce ?? 'GTC';
    const expiresAt = this.resolveExpiry(timeInForce, request.expiresAt ?? null, now);

    const symbolId = this.symbols.requireId(symbolCode);
    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          accountId: account.id,
          symbolId,
          side: request.side,
          type: request.type,
          status: OrderStatus.PENDING,
          timeInForce,
          volume: volume.toString(),
          price: request.price,
          stopPrice: request.type === 'STOP' ? request.price : null,
          stopLoss: request.stopLoss ?? null,
          takeProfit: request.takeProfit ?? null,
          expiresAt: expiresAt === null ? null : new Date(expiresAt),
        },
      });
      await tx.orderEvent.createMany({
        data: [
          {
            orderId: created.id,
            type: 'CREATED',
            toStatus: OrderStatus.NEW,
            payload: { volume: volume.toString(), price: request.price, type: request.type },
          },
          {
            orderId: created.id,
            type: 'ACCEPTED',
            fromStatus: OrderStatus.NEW,
            // NEW → PENDING: accepted and resting, not yet executable.
            toStatus: transitionOrder(OrderStatus.NEW, OrderStatus.PENDING),
            payload: { bid: tick.bid, ask: tick.ask },
          },
        ],
      });
      return created;
    });

    this.metrics.ordersSubmitted.inc({
      symbol: symbolCode,
      type: request.type,
      outcome: 'pending',
    });

    await this.events.publish(DomainEvent.ORDER_CREATED, account.id, {
      orderId: order.id,
      symbol: symbolCode,
      side: request.side,
      type: request.type,
      volume: volume.toString(),
      price: request.price,
    });
    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'ORDER_CREATE',
      resourceType: 'Order',
      resourceId: order.id,
      after: {
        symbol: symbolCode,
        side: request.side,
        type: request.type,
        volume: volume.toString(),
        price: request.price,
        timeInForce,
      },
    });

    return this.toPendingResult(order, symbolCode);
  }

  /**
   * GTC never expires; DAY expires at the next trading-server midnight; GTD
   * carries its own timestamp.
   *
   * DAY is resolved to a timestamp here, once, rather than being re-derived
   * whenever the order is examined — so a server that changes timezone cannot
   * silently reinterpret an order already resting.
   */
  private resolveExpiry(timeInForce: string, requested: number | null, now: number): number | null {
    if (timeInForce === 'GTC') return null;
    if (timeInForce === 'DAY') {
      return endOfTradingDay(
        this.config.getOrThrow('TRADING_SERVER_TIMEZONE', { infer: true }),
        now,
      );
    }
    if (requested === null || requested <= now) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'A GTD order needs an expiry in the future',
        { expiresAt: requested },
      );
    }
    return requested;
  }

  /**
   * Fire a resting order.
   *
   * Called by the trigger engine, never by a trader, so failures are logged and
   * recorded rather than thrown at a caller who could not act on them.
   *
   * The order is *claimed* first — one conditional update from PENDING to
   * TRIGGERED — before anything is priced. Two ticks arriving close together
   * would otherwise both see a resting order and both open a position from it.
   * A claim that changes no rows means another pass won, and this one stops.
   */
  async fillPending(orderId: string, tick: Tick): Promise<'filled' | 'rejected' | 'lost'> {
    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING },
      data: {
        status: transitionOrder(OrderStatus.PENDING, OrderStatus.TRIGGERED),
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) return 'lost';

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { account: true, symbol: true },
    });
    const symbolCode = order.symbol.code;
    const spec = this.symbols.require(symbolCode).spec;
    const side = order.side;
    const volume = toDecimal(order.volume.toString());

    // Filled at the executable price now, not at the resting price. For a limit
    // that is at least as good as asked; for a stop it may be worse, and that
    // slippage is real. Both prices are recorded so the difference is auditable
    // rather than invisible.
    const fillPrice = normalizePrice(spec, entryPriceFor(side, tick));
    const restingPrice = order.price?.toString() ?? fillPrice.toString();

    try {
      const rate = await this.conversion.rate(spec.quoteCurrency, order.account.currency);
      const margin = requiredMargin({
        spec,
        volume,
        price: fillPrice,
        accountLeverage: order.account.leverage,
        accountCurrency: order.account.currency,
        quoteToAccountRate: rate,
      });
      const notional = Money.of(
        notionalValue(spec, volume, fillPrice),
        spec.quoteCurrency,
      ).convertTo(order.account.currency, rate);
      const commission = commissionForLeg(spec, volume, order.account.currency, rate);

      // Risk is evaluated now, against the account as it stands. Nothing was
      // reserved when the order was placed, and the account may have spent its
      // free margin since.
      const valuation = await this.accountState.valuate(order.accountId);
      const context = await this.riskContext.build(valuation, Date.now());
      const decision = this.risk.evaluate(
        {
          symbol: symbolCode,
          spec,
          side,
          volume: volume.toString(),
          price: fillPrice.toString(),
          requiredMargin: margin,
          notional,
        },
        context,
      );

      if (!decision.allowed) {
        await this.rejectTriggered(order.id, order.accountId, symbolCode, decision.violations);
        await this.recordRiskEvent(order.accountId, decision.violations, valuation);
        this.metrics.ordersSubmitted.inc({
          symbol: symbolCode,
          type: order.type,
          outcome: 'rejected',
        });
        return 'rejected';
      }

      const result = await this.prisma.$transaction(async (tx) => {
        // The account's write lock first, before any insert that references it.
        await this.ledger.lockAccount(tx, order.accountId);

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: transitionOrder(OrderStatus.TRIGGERED, OrderStatus.FILLED),
            filledVolume: volume.toString(),
            version: { increment: 1 },
          },
        });
        await tx.orderEvent.createMany({
          data: [
            {
              orderId: order.id,
              type: 'TRIGGERED',
              fromStatus: OrderStatus.PENDING,
              toStatus: OrderStatus.TRIGGERED,
              payload: { restingPrice, bid: tick.bid, ask: tick.ask },
            },
            {
              orderId: order.id,
              type: 'FILLED',
              fromStatus: OrderStatus.TRIGGERED,
              toStatus: OrderStatus.FILLED,
              payload: {
                restingPrice,
                price: fillPrice.toString(),
                // Positive means the fill was worse than the resting price.
                slippage: fillPrice.minus(toDecimal(restingPrice)).abs().toString(),
                bid: tick.bid,
                ask: tick.ask,
              },
            },
          ],
        });
        await tx.execution.create({
          data: {
            orderId: order.id,
            accountId: order.accountId,
            side,
            volume: volume.toString(),
            price: fillPrice.toString(),
            quoteBid: tick.bid,
            quoteAsk: tick.ask,
            quoteAt: new Date(tick.timestamp),
          },
        });

        const position = await this.openPositionForOrder(tx, {
          orderId: order.id,
          accountId: order.accountId,
          symbolId: order.symbolId,
          symbolCode,
          side,
          volume: volume.toString(),
          entryPrice: fillPrice.toString(),
          stopLoss: order.stopLoss?.toString() ?? null,
          takeProfit: order.takeProfit?.toString() ?? null,
          margin,
          commission,
        });
        return position;
      });

      this.metrics.ordersSubmitted.inc({ symbol: symbolCode, type: order.type, outcome: 'filled' });

      await this.events.publish(DomainEvent.ORDER_FILLED, order.accountId, {
        orderId: order.id,
        symbol: symbolCode,
        side,
        volume: volume.toString(),
        price: fillPrice.toString(),
      });
      await this.events.publish(DomainEvent.POSITION_OPENED, order.accountId, {
        positionId: result.id,
        symbol: symbolCode,
        side,
        volume: volume.toString(),
        entryPrice: fillPrice.toString(),
        margin: margin.toString(),
      });
      await this.audit.record({
        actorId: null,
        actorType: 'SYSTEM',
        action: 'ORDER_FILL',
        resourceType: 'Order',
        resourceId: order.id,
        after: {
          symbol: symbolCode,
          restingPrice,
          fillPrice: fillPrice.toString(),
          positionId: result.id,
        },
      });

      return 'filled';
    } catch (error) {
      // The order is claimed as TRIGGERED and must not be left there: a stuck
      // order is invisible to the trader and to every later pass.
      this.logger.error({ err: error, orderId: order.id }, 'Triggered order failed to fill');
      await this.rejectTriggered(order.id, order.accountId, symbolCode, [
        {
          rule: 'fill',
          code: error instanceof DomainError ? error.code : TradingErrorCode.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : 'Fill failed',
        },
      ]);
      return 'rejected';
    }
  }

  /** Move a claimed order to REJECTED, recording why. */
  private async rejectTriggered(
    orderId: string,
    accountId: string,
    symbolCode: string,
    violations: readonly { rule: string; code: string; message: string }[],
  ): Promise<void> {
    const first = violations[0];
    const reason = violations.map((v) => v.message).join('; ');
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: transitionOrder(OrderStatus.TRIGGERED, OrderStatus.REJECTED),
          rejectionCode: first?.code ?? TradingErrorCode.VALIDATION_FAILED,
          version: { increment: 1 },
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId,
          type: 'REJECTED',
          fromStatus: OrderStatus.TRIGGERED,
          toStatus: OrderStatus.REJECTED,
          payload: { reason, symbol: symbolCode },
        },
      });
    });

    // The trader has to be told: a resting order that quietly vanished is worse
    // than one that failed loudly.
    await this.events.publish(DomainEvent.ORDER_REJECTED, accountId, {
      orderId,
      symbol: symbolCode,
      reason,
      code: first?.code ?? TradingErrorCode.VALIDATION_FAILED,
    });
  }

  /** Let a resting order lapse. Called by the trigger engine and by maintenance. */
  async expirePending(orderId: string): Promise<boolean> {
    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING },
      data: {
        status: transitionOrder(OrderStatus.PENDING, OrderStatus.EXPIRED),
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) return false;

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { symbol: true },
    });
    await this.prisma.orderEvent.create({
      data: {
        orderId,
        type: 'EXPIRED',
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.EXPIRED,
        payload: {
          timeInForce: order.timeInForce,
          expiresAt: order.expiresAt?.toISOString() ?? null,
        },
      },
    });
    await this.events.publish(DomainEvent.ORDER_CANCELLED, order.accountId, {
      orderId,
      symbol: order.symbol.code,
      reason: 'EXPIRED',
    });
    return true;
  }

  async cancelPending(userId: string, orderId: string): Promise<PendingOrderResult> {
    const order = await this.loadOwnedOrder(userId, orderId);
    if (order.status !== OrderStatus.PENDING) {
      throw new DomainError(
        TradingErrorCode.ORDER_NOT_MODIFIABLE,
        `This order is ${order.status} and can no longer be cancelled`,
        { status: order.status },
      );
    }

    // Conditional on the status, so a cancel racing a fill loses rather than
    // undoing a position that already exists.
    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PENDING },
      data: { status: OrderStatus.CANCEL_REQUESTED, version: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new DomainError(
        TradingErrorCode.ORDER_NOT_MODIFIABLE,
        'This order changed state before the cancel was applied; it may have filled',
        { orderId },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: transitionOrder(OrderStatus.CANCEL_REQUESTED, OrderStatus.CANCELLED),
          version: { increment: 1 },
        },
      });
      await tx.orderEvent.createMany({
        data: [
          {
            orderId,
            type: 'CANCEL_REQUESTED',
            fromStatus: OrderStatus.PENDING,
            toStatus: OrderStatus.CANCEL_REQUESTED,
          },
          {
            orderId,
            type: 'CANCELLED',
            fromStatus: OrderStatus.CANCEL_REQUESTED,
            toStatus: OrderStatus.CANCELLED,
          },
        ],
      });
    });

    await this.events.publish(DomainEvent.ORDER_CANCELLED, order.accountId, {
      orderId,
      symbol: order.symbol.code,
      reason: 'MANUAL',
    });
    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'ORDER_CANCEL',
      resourceType: 'Order',
      resourceId: orderId,
      before: { status: OrderStatus.PENDING },
      after: { status: OrderStatus.CANCELLED },
    });

    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { symbol: true },
    });
    return this.toPendingResult(updated, updated.symbol.code);
  }

  /**
   * Change a resting order's price, volume or protective levels.
   *
   * Every supplied field is validated against the *new* resting price, not the
   * old one — moving a limit down without re-checking its stop-loss would leave
   * a stop on the wrong side of the order it protects.
   */
  async modifyPending(userId: string, request: ModifyPendingRequest): Promise<PendingOrderResult> {
    const order = await this.loadOwnedOrder(userId, request.orderId);
    if (order.status !== OrderStatus.PENDING) {
      throw new DomainError(
        TradingErrorCode.ORDER_NOT_MODIFIABLE,
        `This order is ${order.status} and can no longer be modified`,
        { status: order.status },
      );
    }

    const symbolCode = order.symbol.code;
    const spec = this.symbols.require(symbolCode).spec;
    const type = order.type === 'STOP' ? 'STOP' : 'LIMIT';
    const now = Date.now();
    const tick = await this.quotes.requireFresh(symbolCode, now);

    const price = request.price ?? order.price?.toString() ?? '';
    if (price === '') {
      throw new DomainError(TradingErrorCode.INVALID_PRICE, 'This order has no resting price', {
        orderId: request.orderId,
      });
    }
    validatePendingPrice(spec, type, order.side, price, tick);

    let volume = toDecimal(order.volume.toString());
    if (request.volume !== undefined) {
      volume = normalizeVolume(spec, request.volume);
      const check = checkVolume(spec, volume);
      if (!check.ok) {
        throw new DomainError(
          TradingErrorCode.INVALID_VOLUME,
          `Volume ${request.volume} is not tradeable for ${symbolCode} (${check.reason})`,
          { requested: request.volume, min: spec.minVolume, max: spec.maxVolume },
        );
      }
    }

    const stopLoss =
      request.stopLoss === undefined ? (order.stopLoss?.toString() ?? null) : request.stopLoss;
    const takeProfit =
      request.takeProfit === undefined
        ? (order.takeProfit?.toString() ?? null)
        : request.takeProfit;
    validateProtectiveLevels(spec, order.side, price, { stopLoss, takeProfit });

    const claimed = await this.prisma.order.updateMany({
      where: { id: request.orderId, status: OrderStatus.PENDING, version: order.version },
      data: { status: OrderStatus.MODIFY_REQUESTED, version: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new DomainError(
        TradingErrorCode.CONCURRENT_MODIFICATION,
        'This order changed while the modification was being prepared',
        { orderId: request.orderId },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: request.orderId },
        data: {
          status: transitionOrder(OrderStatus.MODIFY_REQUESTED, OrderStatus.PENDING),
          price,
          stopPrice: type === 'STOP' ? price : null,
          volume: volume.toString(),
          stopLoss,
          takeProfit,
          version: { increment: 1 },
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: request.orderId,
          type: 'MODIFIED',
          fromStatus: OrderStatus.MODIFY_REQUESTED,
          toStatus: OrderStatus.PENDING,
          payload: {
            // The previous values, so the change is reconstructable from the trail.
            previousPrice: order.price?.toString() ?? null,
            previousVolume: order.volume.toString(),
            previousStopLoss: order.stopLoss?.toString() ?? null,
            previousTakeProfit: order.takeProfit?.toString() ?? null,
            price,
            volume: volume.toString(),
            stopLoss,
            takeProfit,
          },
        },
      });
    });

    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'ORDER_MODIFY',
      resourceType: 'Order',
      resourceId: request.orderId,
      before: { price: order.price?.toString() ?? null, volume: order.volume.toString() },
      after: { price, volume: volume.toString() },
    });

    const updated = await this.prisma.order.findUniqueOrThrow({
      where: { id: request.orderId },
      include: { symbol: true },
    });
    return this.toPendingResult(updated, symbolCode);
  }

  /** Resting orders for an account, newest first. */
  async listPending(userId: string, accountId: string) {
    await this.assertOwnership(userId, accountId);
    const orders = await this.prisma.order.findMany({
      where: { accountId, status: OrderStatus.PENDING },
      include: { symbol: true },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((order) => this.toPendingResult(order, order.symbol.code));
  }

  private async loadOwnedOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { account: true, symbol: true },
    });
    // Ownership failure reads as "not found", so order ids cannot be probed.
    if (order === null || order.account.userId !== userId) {
      throw new DomainError(TradingErrorCode.ORDER_NOT_FOUND, 'Order not found', { orderId });
    }
    return order;
  }

  private toPendingResult(
    order: {
      id: string;
      status: string;
      side: OrderSide;
      type: string;
      volume: { toString(): string };
      price: { toString(): string } | null;
      stopLoss: { toString(): string } | null;
      takeProfit: { toString(): string } | null;
      timeInForce: string;
      expiresAt: Date | null;
      createdAt: Date;
    },
    symbolCode: string,
  ): PendingOrderResult {
    return {
      orderId: order.id,
      status: order.status,
      symbol: symbolCode,
      side: order.side,
      type: order.type,
      volume: order.volume.toString(),
      price: order.price?.toString() ?? '',
      stopLoss: order.stopLoss?.toString() ?? null,
      takeProfit: order.takeProfit?.toString() ?? null,
      timeInForce: order.timeInForce,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
    };
  }

  async listOrders(userId: string, accountId: string, limit: number) {
    await this.assertOwnership(userId, accountId);
    const orders = await this.prisma.order.findMany({
      where: { accountId },
      include: { symbol: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return orders.map((order) => ({
      id: order.id,
      symbol: order.symbol.code,
      side: order.side,
      type: order.type,
      status: order.status,
      volume: order.volume.toString(),
      filledVolume: order.filledVolume.toString(),
      positionId: order.positionId,
      createdAt: order.createdAt.toISOString(),
    }));
  }

  async orderEvents(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { account: true },
    });
    if (order === null || order.account.userId !== userId) {
      throw new DomainError(TradingErrorCode.ORDER_NOT_FOUND, 'Order not found', { orderId });
    }
    const events = await this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return events.map((event) => ({
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      payload: event.payload,
      at: event.createdAt.toISOString(),
    }));
  }

  private async assertOwnership(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, userId } });
    if (account === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', {
        accountId,
      });
    }
  }

  private async recordRiskEvent(
    accountId: string,
    violations: readonly { rule: string; code: string; message: string }[],
    valuation: { state: { equity: Money; freeMargin: Money; usedMargin: Money } },
  ): Promise<void> {
    const first = violations[0];
    if (first === undefined) return;
    await this.prisma.riskEvent
      .create({
        data: {
          accountId,
          rule: first.rule,
          code: first.code,
          severity: 'REJECTED',
          message: violations.map((v) => v.message).join('; '),
          // The account state at the instant of the decision, so the rejection
          // can be re-examined later without guessing what the numbers were.
          snapshot: {
            equity: valuation.state.equity.toString(),
            freeMargin: valuation.state.freeMargin.toString(),
            usedMargin: valuation.state.usedMargin.toString(),
          },
        },
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Failed to record risk event');
      });
  }
}

/** Exposed for tests: the engine the service evaluates orders with. */
export const TRADING_RISK_RULES = DEFAULT_RISK_RULES;

/** Helper used by the close path to size margin release proportionally. */
export function proportionOf(part: string, whole: string): string {
  const w = toDecimal(whole);
  if (w.isZero()) return '0';
  return toDecimal(part).div(w).toString();
}
