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
  Permission,
  TradingErrorCode,
} from '@tp/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from '../market/quote.service';
import { ConversionService } from '../market/conversion.service';
import { AccountAccessService } from '../accounts/account-access.service';
import { KillSwitchService } from '../operations/kill-switch.service';
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
import { requireTenantId } from '@tp/tenancy';

/**
 * Carries a risk rejection out of the transaction that discovered it.
 *
 * Risk is now evaluated inside the account's write lock, which means a rejection
 * has to escape a transaction that must roll back. It cannot record the risk
 * event on its way out — a write inside a rolled-back transaction is a write
 * that never happened, and the rejection would leave no trace at all.
 *
 * So the decision travels out in this, and the caller records it once the
 * rollback is complete.
 */
class RiskRejection extends Error {
  constructor(
    readonly violations: readonly { rule: string; code: string; message: string }[],
    readonly valuation: { state: { equity: Money; freeMargin: Money; usedMargin: Money } },
  ) {
    super('Order rejected by risk');
    this.name = 'RiskRejection';
  }
}

/**
 * Market-order submission.
 *
 * The ordering below is not arbitrary, and it changed once for a reason worth
 * knowing.
 *
 * Everything that can reject on the *request alone* — validation, session,
 * volume, pricing — happens before the transaction opens, so a malformed order
 * costs one read-only pass and holds no row locks.
 *
 * **Margin and risk cannot be checked there**, and for a long time they were.
 * They read the account's free margin, which another order can spend between the
 * read and the write. Two orders arriving together both saw the same free margin,
 * both concluded they fitted, and both opened: a $5,000 account holding $9,167 of
 * margin, past its stop-out level from the instant it was created. That check now
 * happens inside the transaction, after the account's write lock, where the
 * number it reads cannot change before it is spent.
 *
 * The cost is that a risk rejection now opens a transaction and rolls it back.
 * That is the correct price: a lock held for the length of one evaluation, in
 * exchange for an invariant that cannot be raced.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly risk = new RiskEngine(DEFAULT_RISK_RULES);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountAccessService,
    private readonly killSwitch: KillSwitchService,
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
    // Opening a position takes on risk, so the halt applies. Closing one does
    // not, and deliberately does not consult this.
    this.killSwitch.assertMayOpenRisk();
    const now = Date.now();
    const symbolCode = request.symbol.toUpperCase();
    const instrument = this.symbols.require(symbolCode);
    const spec = instrument.spec;

    const { account } = await this.access.resolve(
      userId,
      request.accountId,
      Permission.ORDERS_CREATE,
    );
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

    const proposed: ProposedOrder = {
      symbol: symbolCode,
      spec,
      side: request.side,
      volume: volume.toString(),
      price: entryPrice.toString(),
      requiredMargin: margin,
      notional,
    };

    const symbolId = this.symbols.requireId(symbolCode);

    const result = await this.runGuarded(account.id, symbolCode, 'MARKET', async (tx) => {
      // First statement, deliberately. Inserting the order takes a share lock on
      // this account row and the ledger post later wants it exclusively; two
      // concurrent orders would deadlock on that pair. See LedgerService.lockAccount.
      await this.ledger.lockAccount(tx, account.id);

      /**
       * Risk is evaluated **under the lock**, and this is the whole reason the
       * transaction is shaped this way.
       *
       * It used to be evaluated above, before the transaction opened. Two orders
       * arriving together both read the same free margin, both concluded they
       * fitted, and both then took the lock in turn and opened. A $5,000 account
       * ended up holding $9,167 of margin — an account already past its stop-out
       * level the instant it was created, on positions it should never have been
       * allowed to take.
       *
       * A check outside the lock is a check of a number that can change before
       * it is used. The account row has to be held from the moment its free
       * margin is read to the moment that margin is spent, or the read means
       * nothing.
       */
      const valuation = await this.accountState.valuate(account.id, tx);
      const context = await this.riskContext.build(valuation, now, tx);
      const decision = this.risk.evaluate(proposed, context);
      if (!decision.allowed) throw new RiskRejection(decision.violations, valuation);

      const order = await tx.order.create({
        data: {
          tenantId: requireTenantId(),
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
            tenantId: requireTenantId(),
            orderId: order.id,
            type: 'CREATED',
            toStatus: OrderStatus.NEW,
            payload: { volume: volume.toString() },
          },
          {
            tenantId: requireTenantId(),
            orderId: order.id,
            type: 'ACCEPTED',
            fromStatus: OrderStatus.NEW,
            toStatus: OrderStatus.ACCEPTED,
          },
          {
            tenantId: requireTenantId(),
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
          tenantId: requireTenantId(),
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
      // The position the fill created. `position.opened` names it too, but a
      // subscriber that cares about *this order* should not have to correlate
      // two events by timing to learn what became of it.
      positionId: result.position.id,
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
        tenantId: requireTenantId(),
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
        tenantId: requireTenantId(),
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
    this.killSwitch.assertMayOpenRisk();
    const now = Date.now();
    const symbolCode = request.symbol.toUpperCase();
    const instrument = this.symbols.require(symbolCode);
    const spec = instrument.spec;

    const { account } = await this.access.resolve(
      userId,
      request.accountId,
      Permission.ORDERS_CREATE,
    );
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
          tenantId: requireTenantId(),
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
            tenantId: requireTenantId(),
            orderId: created.id,
            type: 'CREATED',
            toStatus: OrderStatus.NEW,
            payload: { volume: volume.toString(), price: request.price, type: request.type },
          },
          {
            tenantId: requireTenantId(),
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

      const proposed = {
        symbol: symbolCode,
        spec,
        side,
        volume: volume.toString(),
        price: fillPrice.toString(),
        requiredMargin: margin,
        notional,
      };

      let result;
      try {
        result = await this.prisma.$transaction(async (tx) => {
          // The account's write lock first, before any insert that references it.
          await this.ledger.lockAccount(tx, order.accountId);

          /**
           * Risk is evaluated here, under the lock, against the account as it
           * stands. Nothing was reserved when the order was placed and the
           * account may have spent its free margin since — and, because a resting
           * order fills from the tick loop while the owner may be submitting a
           * market order by hand, "since" can mean "in the last millisecond".
           *
           * Evaluating this above the transaction, as it was, let a fill and a
           * manual order each see free margin the other was about to spend.
           */
          const valuation = await this.accountState.valuate(order.accountId, tx);
          const context = await this.riskContext.build(valuation, Date.now(), tx);
          const decision = this.risk.evaluate(proposed, context);
          if (!decision.allowed) throw new RiskRejection(decision.violations, valuation);

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
                tenantId: requireTenantId(),
                orderId: order.id,
                type: 'TRIGGERED',
                fromStatus: OrderStatus.PENDING,
                toStatus: OrderStatus.TRIGGERED,
                payload: { restingPrice, bid: tick.bid, ask: tick.ask },
              },
              {
                tenantId: requireTenantId(),
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
              tenantId: requireTenantId(),
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
      } catch (error) {
        if (!(error instanceof RiskRejection)) throw error;

        // After the rollback, never inside it. Both of these are writes, and a
        // write in a transaction that rolled back is a write that never
        // happened — the order would stay TRIGGERED and the rejection would
        // leave no trace.
        await this.rejectTriggered(order.id, order.accountId, symbolCode, error.violations);
        await this.recordRiskEvent(order.accountId, error.violations, error.valuation);
        this.metrics.ordersSubmitted.inc({
          symbol: symbolCode,
          type: order.type,
          outcome: 'rejected',
        });
        return 'rejected';
      }

      this.metrics.ordersSubmitted.inc({ symbol: symbolCode, type: order.type, outcome: 'filled' });

      await this.events.publish(DomainEvent.ORDER_FILLED, order.accountId, {
        orderId: order.id,
        positionId: result.id,
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
          tenantId: requireTenantId(),
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
        tenantId: requireTenantId(),
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
    const order = await this.loadOwnedOrder(userId, orderId, Permission.ORDERS_CANCEL);
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
            tenantId: requireTenantId(),
            orderId,
            type: 'CANCEL_REQUESTED',
            fromStatus: OrderStatus.PENDING,
            toStatus: OrderStatus.CANCEL_REQUESTED,
          },
          {
            tenantId: requireTenantId(),
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
    /**
     * Modifying a resting order is refused during a halt; cancelling one is not.
     * A trader who wants their order gone must always be able to take it away,
     * and moving it is a new decision about where risk sits.
     */
    this.killSwitch.assertMayOpenRisk();
    const order = await this.loadOwnedOrder(userId, request.orderId, Permission.ORDERS_MODIFY);
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
          tenantId: requireTenantId(),
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

  /**
   * Loads an order the caller may act on.
   *
   * The account is resolved through `AccountAccessService` rather than by
   * comparing `order.account.userId` here, so that whatever reaches an account
   * — ownership today, a master link tomorrow — reaches its orders by the same
   * decision. A second copy of the rule is a second thing to keep in step.
   *
   * A refusal reads as "order not found", not "account not found": the caller
   * asked about an order and must not learn that the id is real but foreign.
   */
  private async loadOwnedOrder(userId: string, orderId: string, needs: Permission) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { account: true, symbol: true },
    });
    if (order === null) {
      throw new DomainError(TradingErrorCode.ORDER_NOT_FOUND, 'Order not found', { orderId });
    }
    try {
      await this.access.resolve(userId, order.accountId, needs);
    } catch {
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
    // Resolved for its authorisation throw; the events are read by id below.
    await this.loadOwnedOrder(userId, orderId, Permission.ORDERS_READ);
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
    await this.access.resolve(userId, accountId, Permission.ORDERS_READ);
  }

  /**
   * Runs a write that evaluates risk under the account lock.
   *
   * The transaction body throws `RiskRejection` when the decision goes against
   * it. This catches that *after* the rollback and does the three things a
   * rejection owes: record the risk event, count it, and tell the caller why in
   * an error a client can act on.
   *
   * Every violation is reported, not just the first, so a trader fixes all of
   * them in one attempt rather than discovering them one order at a time.
   */
  private async runGuarded<T>(
    accountId: string,
    symbolCode: string,
    orderType: string,
    body: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(body);
    } catch (error) {
      if (!(error instanceof RiskRejection)) throw error;

      await this.recordRiskEvent(accountId, error.violations, error.valuation);
      this.metrics.ordersSubmitted.inc({
        symbol: symbolCode,
        type: orderType,
        outcome: 'rejected',
      });

      const first = error.violations[0];
      throw new DomainError(
        (first?.code as TradingErrorCode) ?? TradingErrorCode.VALIDATION_FAILED,
        first?.message ?? 'Order rejected by risk',
        {
          violations: error.violations.map((v) => `${v.rule}: ${v.message}`).join('; '),
        },
      );
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
          tenantId: requireTenantId(),
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
