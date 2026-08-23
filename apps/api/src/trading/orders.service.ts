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
import { validateProtectiveLevels } from '@tp/trading-core';
import { DEFAULT_RISK_RULES, RiskEngine, type ProposedOrder } from '@tp/risk-core';
import { DomainError, OrderStatus, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { SymbolsService } from '../symbols/symbols.service';
import { QuoteService } from '../market/quote.service';
import { ConversionService } from '../market/conversion.service';
import { LedgerService } from '../accounts/ledger.service';
import { MetricsService } from '../metrics/metrics.service';
import { AuditService } from '../common/audit/audit.service';
import { isSessionOpen } from '../market/session';
import { AccountStateService } from './account-state.service';
import { RiskContextBuilder } from './risk-context.builder';
import type { OpenPositionRequest, OrderResult } from './trading.types';

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

      const position = await tx.position.create({
        data: {
          accountId: account.id,
          symbolId,
          side: request.side,
          status: 'OPEN',
          volume: volume.toString(),
          initialVolume: volume.toString(),
          entryPrice: entryPrice.toString(),
          currentPrice: entryPrice.toString(),
          stopLoss: request.stopLoss ?? null,
          takeProfit: request.takeProfit ?? null,
          margin: margin.toString(),
          commission: commission.toString(),
        },
      });

      await tx.order.update({ where: { id: order.id }, data: { positionId: position.id } });
      await tx.positionEvent.create({
        data: {
          positionId: position.id,
          type: 'OPENED',
          toStatus: 'OPEN',
          payload: {
            entryPrice: entryPrice.toString(),
            volume: volume.toString(),
            margin: margin.toString(),
          },
        },
      });

      // Commission is realized at open, so it belongs in the ledger now — not
      // folded into floating P&L, where it would be counted twice.
      if (commission.isPositive()) {
        await this.ledger.post(tx, {
          accountId: account.id,
          type: 'COMMISSION',
          amount: commission.negated(),
          referenceType: 'Position',
          referenceId: position.id,
          idempotencyKey: `commission:open:${position.id}`,
          description: `Commission on opening ${symbolCode}`,
        });
      }

      return { order, position };
    });

    this.metrics.ordersSubmitted.inc({ symbol: symbolCode, type: 'MARKET', outcome: 'filled' });
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
