import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IDEMPOTENCY_HEADER } from '@tp/shared-types';
import { MetricsService } from '../metrics/metrics.service';
import { clientSkewMs } from './order-timeline';
import { Permission } from '@tp/shared-types';
import { rateLimits, RATE_LIMIT_WINDOW_MS } from '../config/env.schema';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  CurrentUser,
  subjectOf,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { AccountAccessService } from '../accounts/account-access.service';
import { AccountStateService } from './account-state.service';
import { OrdersService } from './orders.service';
import { PositionsService } from './positions.service';
import {
  AccountQueryDto,
  CloseAllDto,
  ClosePositionDto,
  ListQueryDto,
  ModifyPendingDto,
  ModifyPositionDto,
  OpenPositionDto,
  PlacePendingDto,
} from './dto/trading.dto';
import type {
  CloseAllResult,
  CloseResult,
  OrderPreview,
  OrderResult,
} from './trading.types';

/**
 * Runs an operation under an idempotency key.
 *
 * A replayed key returns the stored result without touching the engine. A failed
 * attempt releases the key so the client can fix the request and retry.
 */
async function idempotent<T>(
  idempotency: IdempotencyService,
  scope: string,
  key: string,
  body: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const claim = await idempotency.claim<T>(scope, key, body);
  if (claim.kind === 'replayed') return claim.result;
  try {
    const result = await operation();
    await claim.complete(result);
    return result;
  } catch (error) {
    await claim.abandon();
    throw error;
  }
}

@ApiTags('trading')
@ApiHeader({ name: IDEMPOTENCY_HEADER, required: true, description: 'Required on every mutation' })
@Controller()
export class TradingController {
  constructor(
    private readonly access: AccountAccessService,
    private readonly orders: OrdersService,
    private readonly positions: PositionsService,
    private readonly accountState: AccountStateService,
    private readonly idempotency: IdempotencyService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Time an order submission and record how it ended.
   *
   * Measured here rather than inside `OrdersService`, because the number this
   * is about is a person waiting for an answer. The service is also called by
   * the trigger engine and by the external execution path, and neither of those
   * has anybody watching a spinner; folding them in would move the median
   * towards work nobody is waiting on.
   *
   * Refusals are timed too. A rejection that takes two seconds is still two
   * seconds of a trader not knowing, and it is the case most likely to be slow
   * — a refusal usually happens after the risk checks, not before them.
   */
  /**
   * How far behind the server the client believed it was when it sent this.
   *
   * Read from a header, recorded, and never used to decide anything. A
   * browser's clock is whatever the person set it to, so it cannot be allowed
   * near a fill price or a session check. What it is good for is the
   * population: a fleet of clients whose skew moves together is a real signal,
   * and `docs/anti-fraud.md` names it as one.
   *
   * Bounded before it is recorded. An unbounded value from a client would let
   * anybody push a histogram's sum wherever they liked, which is a metric
   * nobody can read afterwards.
   */
  private recordClientSkew(header: string | undefined): void {
    if (header === undefined) return;
    const sentAt = Number(header);
    const skew = clientSkewMs(Number.isFinite(sentAt) ? sentAt : null, Date.now());
    if (skew === null) return;
    const bounded = Math.max(-MAX_CLIENT_SKEW_MS, Math.min(MAX_CLIENT_SKEW_MS, skew));
    this.metrics.clientClockSkew.observe(bounded / 1000);
  }

  private async timed<T>(run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let outcome = 'accepted';
    try {
      return await run();
    } catch (error) {
      outcome = 'refused';
      throw error;
    } finally {
      this.metrics.orderAck.observe({ outcome }, (Date.now() - startedAt) / 1000);
    }
  }

  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.ORDERS_CREATE)
  @Post('orders')
  @ApiOperation({ summary: 'Submit a market order and open a position' })
  async open(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: OpenPositionDto,
    @IdempotencyKey() key: string,
    @Headers('x-client-sent-at') clientSentAt?: string,
  ): Promise<OrderResult> {
    this.recordClientSkew(clientSentAt);
    return this.timed(() =>
      idempotent(this.idempotency, `orders:${user.id}`, key, body, () =>
        this.orders.openPosition(user.id, {
          accountId: body.accountId,
          symbol: body.symbol,
          side: body.side,
          volume: body.volume,
          stopLoss: body.stopLoss ?? null,
          takeProfit: body.takeProfit ?? null,
        }),
      ),
    );
  }

  /**
   * What an order would cost, without placing it.
   *
   * A read, and typed as one everywhere it matters: `ORDERS_READ` rather than
   * `ORDERS_CREATE`, no idempotency key, and nothing written. An order ticket
   * calls this as the trader types, so it must be cheap to call and impossible
   * to mistake for a submission.
   *
   * `POST` rather than `GET` because the input is a structured order, not a
   * handful of query parameters — and because a stop loss in a URL ends up in
   * an access log.
   */
  @Throttle({ default: { limit: rateLimits.api, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.ORDERS_READ)
  @Post('orders/preview')
  @ApiOperation({ summary: 'Estimate margin, commission and risk for an order without placing it' })
  async preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: OpenPositionDto,
  ): Promise<OrderPreview> {
    return this.orders.preview(user.id, {
      accountId: body.accountId,
      symbol: body.symbol,
      side: body.side,
      volume: body.volume,
      stopLoss: body.stopLoss ?? null,
      takeProfit: body.takeProfit ?? null,
    });
  }

  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.ORDERS_CREATE)
  @Post('orders/pending')
  @ApiOperation({ summary: 'Place a resting LIMIT or STOP order' })
  async placePending(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PlacePendingDto,
    @IdempotencyKey() key: string,
  ) {
    return idempotent(this.idempotency, `pending:${user.id}`, key, body, () =>
      this.orders.placePending(user.id, {
        accountId: body.accountId,
        symbol: body.symbol,
        side: body.side,
        type: body.type,
        volume: body.volume,
        price: body.price,
        stopLoss: body.stopLoss ?? null,
        takeProfit: body.takeProfit ?? null,
        timeInForce: body.timeInForce,
        expiresAt: body.expiresAt ?? null,
      }),
    );
  }

  @RequirePermissions(Permission.ORDERS_READ)
  @Get('orders/pending')
  @ApiOperation({ summary: 'Resting orders for an account' })
  listPending(@CurrentUser() user: AuthenticatedUser, @Query() query: AccountQueryDto) {
    return this.orders.listPending(subjectOf(user), query.accountId);
  }

  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.ORDERS_MODIFY)
  @Patch('orders/:id')
  @ApiOperation({ summary: 'Change a resting order’s price, volume or levels' })
  async modifyPending(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ModifyPendingDto,
    @IdempotencyKey() key: string,
  ) {
    return idempotent(this.idempotency, `pending-modify:${user.id}`, key, { id, ...body }, () =>
      this.orders.modifyPending(user.id, {
        orderId: id,
        ...(body.price === undefined ? {} : { price: body.price }),
        ...(body.volume === undefined ? {} : { volume: body.volume }),
        ...(body.stopLoss === undefined ? {} : { stopLoss: body.stopLoss }),
        ...(body.takeProfit === undefined ? {} : { takeProfit: body.takeProfit }),
      }),
    );
  }

  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.ORDERS_CANCEL)
  @Delete('orders/:id')
  @ApiOperation({ summary: 'Cancel a resting order' })
  async cancelPending(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
  ) {
    return idempotent(this.idempotency, `pending-cancel:${user.id}`, key, { id }, () =>
      this.orders.cancelPending(user.id, id),
    );
  }

  @RequirePermissions(Permission.ORDERS_READ)
  @Get('orders')
  @ApiOperation({ summary: 'Recent orders for an account' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQueryDto) {
    return this.orders.listOrders(subjectOf(user), query.accountId, query.limit);
  }

  @RequirePermissions(Permission.ORDERS_READ)
  @Get('orders/:id/events')
  @ApiOperation({ summary: 'Every recorded state change for one order' })
  events(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.orderEvents(subjectOf(user), id);
  }

  @RequirePermissions(Permission.POSITIONS_READ)
  @Get('positions')
  @ApiOperation({ summary: 'Positions for an account' })
  positionsFor(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQueryDto) {
    return this.positions.list(subjectOf(user), query.accountId, query.includeClosed, query.limit);
  }

  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.POSITIONS_CLOSE)
  @Post('positions/:id/close')
  @ApiOperation({ summary: 'Close a position in whole or in part' })
  async close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ClosePositionDto,
    @IdempotencyKey() key: string,
  ): Promise<CloseResult> {
    return idempotent(this.idempotency, `close:${user.id}`, key, { id, ...body }, () =>
      this.positions.close(user.id, id, body.volume ?? null),
    );
  }

  /**
   * Close everything on one account.
   *
   * One stated intent instead of a burst of unrelated closes, and one audit
   * row that records what was asked for as well as what happened.
   *
   * Deliberately **not atomic**, and the result says so per position: each
   * close takes its own lock, quote and ledger entry, so one unpriceable
   * instrument must not roll back closes that already happened at real prices.
   * A 200 here means the command ran, not that everything shut — read
   * `refused`.
   */
  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.POSITIONS_CLOSE)
  @Post('positions/close-all')
  @ApiOperation({ summary: 'Close every open position on an account. Reports each one.' })
  async closeAll(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CloseAllDto,
    @IdempotencyKey() key: string,
  ): Promise<CloseAllResult> {
    return idempotent(this.idempotency, `close-all:${user.id}`, key, body, () =>
      this.positions.closeAll(user.id, body.accountId),
    );
  }

  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.POSITIONS_MODIFY)
  @Patch('positions/:id')
  @ApiOperation({ summary: 'Change stop-loss or take-profit' })
  async modify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ModifyPositionDto,
    @IdempotencyKey() key: string,
  ) {
    return idempotent(this.idempotency, `modify:${user.id}`, key, { id, ...body }, () =>
      this.positions.modify(user.id, {
        positionId: id,
        ...(body.stopLoss === undefined ? {} : { stopLoss: body.stopLoss }),
        ...(body.takeProfit === undefined ? {} : { takeProfit: body.takeProfit }),
        ...(body.trailingStopDistance === undefined
          ? {}
          : { trailingStopDistance: body.trailingStopDistance }),
      }),
    );
  }

  @Throttle({ default: { limit: Math.ceil(rateLimits.orders / 2), ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.POSITIONS_CLOSE, Permission.ORDERS_CREATE)
  @Post('positions/:id/reverse')
  @ApiOperation({ summary: 'Close a position and open the same size the other way' })
  async reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string,
  ) {
    return idempotent(this.idempotency, `reverse:${user.id}`, key, { id }, () =>
      this.positions.reverse(user.id, id),
    );
  }

  @RequirePermissions(Permission.POSITIONS_READ)
  @Get('trades')
  @ApiOperation({ summary: 'Completed round trips, newest first' })
  trades(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQueryDto) {
    return this.positions.trades(subjectOf(user), query.accountId, query.limit);
  }

  @RequirePermissions(Permission.ACCOUNTS_READ)
  @Get('accounts/:id/state')
  @ApiOperation({ summary: 'Live balance, equity, margin and floating P&L' })
  async state(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    /**
     * `valuate()` takes an account id and checks nothing about who is asking —
     * it is also called by the tick loop and the snapshot job, which have no
     * caller to check. So the authorisation happens here, explicitly.
     *
     * This line used to be `await this.positions.list(user.id, id, false, 1)`,
     * whose result was discarded: the call existed only for the throw inside
     * it. That worked, and it was one "remove the unused call" away from
     * turning this route into an IDOR with nothing in the diff to notice.
     */
    await this.access.resolve(subjectOf(user), id, Permission.ACCOUNTS_READ);
    const valuation = await this.accountState.valuate(id);
    // The snapshot carries realized P&L; the tick-driven frames do not, because
    // nothing about realized P&L changes on a tick. See account-state.service.
    const realized = await this.accountState.realized(id, valuation.currency);
    return {
      ...this.accountState.toDto(valuation, realized),
      positions: valuation.positions.map((position) => ({
        positionId: position.positionId,
        symbol: position.symbol,
        side: position.side,
        volume: position.volume,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
        floatingPnl: position.floatingPnl.toString(),
        commission: position.commission.toString(),
        swap: position.swap.toString(),
        netPnl: position.netPnl.toString(),
        margin: position.margin.toString(),
        stale: position.stale,
      })),
    };
  }
}

/**
 * A client may be an hour out and still be honest — a laptop that woke up, a
 * phone in the wrong timezone. Beyond a day it is not a clock, it is noise or
 * somebody testing what the histogram will accept.
 */
const MAX_CLIENT_SKEW_MS = 24 * 60 * 60 * 1000;
