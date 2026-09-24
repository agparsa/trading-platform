import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { WalletService, type WalletView } from './wallet.service';
import { TransferDto } from './dto/wallet.dto';

@ApiTags('wallet')
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({ summary: 'Your wallets, one per currency' })
  async mine(@CurrentUser() user: AuthenticatedUser): Promise<{ wallets: readonly WalletView[] }> {
    return { wallets: await this.wallets.list(user.id) };
  }

  /**
   * A wallet's movements.
   *
   * Scoped to the caller's own wallets, and the ownership check is a lookup
   * rather than a filter on the query — reading somebody else's is
   * `wallet.read_any`, which lives in the administrative section. Spelling the
   * two the same way is how a support tool becomes a way to browse everybody's
   * money.
   */
  @Get(':id/transactions')
  @RequirePermissions(Permission.WALLET_READ)
  @ApiOperation({ summary: 'Movements on one of your wallets' })
  @ApiQuery({ name: 'limit', required: false, type: String })
  async transactions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ): Promise<{ transactions: readonly unknown[] }> {
    const owned = await this.wallets.list(user.id);
    if (!owned.some((wallet) => wallet.id === id)) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Wallet not found');
    }
    const take = limit === undefined ? 100 : Number.parseInt(limit, 10);
    return {
      transactions: await this.wallets.transactions(id, Number.isFinite(take) ? take : 100),
    };
  }

  /**
   * Move money between your wallet and one of your trading accounts.
   *
   * The idempotency key is the client's and covers both sides: a retried request
   * finds the movement already posted on each ledger and returns the same answer
   * rather than moving the money twice.
   *
   * No currency in the body. The amount is in the account's currency, because
   * both pots are, and a client that could name a currency could name the wrong
   * one.
   */
  @Post('transfer')
  @RequirePermissions(Permission.WALLET_TRANSFER)
  @ApiOperation({ summary: 'Move money between a wallet and a trading account' })
  async transfer(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: TransferDto,
    @IdempotencyKey() idempotencyKey: string,
  ) {
    return this.wallets.transfer({
      userId: user.id,
      accountId: body.accountId,
      direction: body.direction,
      amount: body.amount,
      idempotencyKey,
      actorId: user.id,
    });
  }
}
