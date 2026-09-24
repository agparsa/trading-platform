import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { WalletService, type WalletView } from './wallet.service';
import { WalletAdjustmentDto, WalletStatusDto } from './dto/wallet.dto';

/**
 * Somebody else's money.
 *
 * Separate from `/wallet` rather than the same routes with a wider permission,
 * because "read my wallet" and "read anyone's wallet" are different powers and a
 * route that decides which one it is from the caller's role is a route where
 * that decision can go wrong quietly. The paths differ, the capabilities differ,
 * and the code that answers them differs.
 */
@ApiTags('admin')
@Controller('admin/wallets')
export class AdminWalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  @RequirePermissions(Permission.WALLET_READ_ANY)
  @ApiOperation({ summary: "One person's wallets" })
  @ApiQuery({ name: 'userId', required: true, type: String })
  async forUser(@Query('userId', ParseUUIDPipe) userId: string): Promise<{
    wallets: readonly WalletView[];
  }> {
    return { wallets: await this.wallets.list(userId) };
  }

  @Get(':id/transactions')
  @RequirePermissions(Permission.WALLET_READ_ANY)
  @ApiOperation({ summary: 'Movements on any wallet' })
  @ApiQuery({ name: 'limit', required: false, type: String })
  async transactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ): Promise<{ transactions: readonly unknown[] }> {
    const take = limit === undefined ? 100 : Number.parseInt(limit, 10);
    return {
      transactions: await this.wallets.transactions(id, Number.isFinite(take) ? take : 100),
    };
  }

  /**
   * Record money arriving from outside, or correct a mistake.
   *
   * There is no payment provider yet and this does not pretend to be one: it is
   * the manual path every firm has anyway, an operator recording a bank transfer
   * they can see. `wallet.adjust` is held by nobody except an administrator, and
   * no role may hold it alongside the ability to open a position — inventing
   * money and using it must be two people.
   */
  @Post(':id/adjustments')
  @RequirePermissions(Permission.WALLET_ADJUST)
  @ApiOperation({ summary: 'Credit or debit a wallet' })
  async adjust(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WalletAdjustmentDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<WalletView> {
    return this.wallets.adjust({
      walletId: id,
      type: body.type,
      amount: body.amount,
      reason: body.reason,
      ...(body.compensatesId === undefined ? {} : { compensatesId: body.compensatesId }),
      idempotencyKey,
      actorId: actor.id,
    });
  }

  /**
   * Freeze or release a wallet.
   *
   * Freezing holds money; it does not take it. A risk manager holds this and not
   * `wallet.adjust`, so the audit trail can always say which of the two happened.
   */
  @Post(':id/status')
  @RequirePermissions(Permission.WALLET_MANAGE)
  @ApiOperation({ summary: 'Freeze or release a wallet' })
  async setStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: WalletStatusDto,
  ): Promise<WalletView> {
    return this.wallets.setStatus({
      walletId: id,
      status: body.status,
      reason: body.reason,
      actorId: actor.id,
    });
  }
}
