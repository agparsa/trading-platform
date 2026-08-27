import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IDEMPOTENCY_HEADER } from '@tp/shared-types';
import { Permission } from '@tp/shared-types';
import { rateLimits, RATE_LIMIT_WINDOW_MS } from '../config/env.schema';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { AccountAccessService } from '../accounts/account-access.service';
import { AccountStateService } from './account-state.service';
import { OrdersService } from './orders.service';
import { PositionsService } from './positions.service';
import {
  AccountQueryDto,
  ClosePositionDto,
  ListQueryDto,
  ModifyPendingDto,
  ModifyPositionDto,
  OpenPositionDto,
  PlacePendingDto,
} from './dto/trading.dto';
import type { CloseResult, OrderResult } from './trading.types';

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
  ) {}

  @Throttle({ default: { limit: rateLimits.orders, ttl: RATE_LIMIT_WINDOW_MS } })
  @RequirePermissions(Permission.ORDERS_CREATE)
  @Post('orders')
  @ApiOperation({ summary: 'Submit a market order and open a position' })
  async open(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: OpenPositionDto,
    @IdempotencyKey() key: string,
  ): Promise<OrderResult> {
    return idempotent(this.idempotency, `orders:${user.id}`, key, body, () =>
      this.orders.openPosition(user.id, {
        accountId: body.accountId,
        symbol: body.symbol,
        side: body.side,
        volume: body.volume,
        stopLoss: body.stopLoss ?? null,
        takeProfit: body.takeProfit ?? null,
      }),
    );
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
    return this.orders.listPending(user.id, query.accountId);
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
    return this.orders.listOrders(user.id, query.accountId, query.limit);
  }

  @RequirePermissions(Permission.ORDERS_READ)
  @Get('orders/:id/events')
  @ApiOperation({ summary: 'Every recorded state change for one order' })
  events(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.orderEvents(user.id, id);
  }

  @RequirePermissions(Permission.POSITIONS_READ)
  @Get('positions')
  @ApiOperation({ summary: 'Positions for an account' })
  positionsFor(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQueryDto) {
    return this.positions.list(user.id, query.accountId, query.includeClosed, query.limit);
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
    return this.positions.trades(user.id, query.accountId, query.limit);
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
    await this.access.resolve(user.id, id, Permission.ACCOUNTS_READ);
    const valuation = await this.accountState.valuate(id);
    return {
      ...this.accountState.toDto(valuation),
      positions: valuation.positions.map((position) => ({
        positionId: position.positionId,
        symbol: position.symbol,
        side: position.side,
        volume: position.volume,
        entryPrice: position.entryPrice,
        currentPrice: position.currentPrice,
        floatingPnl: position.floatingPnl.toString(),
        margin: position.margin.toString(),
        stale: position.stale,
      })),
    };
  }
}
