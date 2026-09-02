import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import {
  WithdrawalsService,
  type WithdrawalTerms,
  type WithdrawalView,
} from './withdrawals.service';
import { RequestWithdrawalDto } from './dto/withdrawals.dto';

/**
 * A person's own withdrawals.
 *
 * `POST /withdrawals` debits the wallet at once — see the service. The screen
 * that calls it must say so, and must not show a balance that includes money
 * already asked for.
 */
@ApiTags('withdrawals')
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  @Get('terms')
  @RequirePermissions(Permission.WITHDRAWALS_READ)
  @ApiOperation({ summary: 'What you may withdraw right now, and why not' })
  async terms(
    @CurrentUser() user: AuthenticatedUser,
    @Query('currency') currency = 'USD',
  ): Promise<WithdrawalTerms> {
    return this.withdrawals.terms(user.id, currency.toUpperCase().slice(0, 3));
  }

  @Get()
  @RequirePermissions(Permission.WITHDRAWALS_READ)
  @ApiOperation({ summary: 'Your withdrawals, newest first' })
  async mine(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ withdrawals: readonly WithdrawalView[] }> {
    return { withdrawals: await this.withdrawals.list(user.id) };
  }

  @Get(':id')
  @RequirePermissions(Permission.WITHDRAWALS_READ)
  @ApiOperation({ summary: 'One of your withdrawals' })
  async one(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WithdrawalView> {
    return this.withdrawals.get(user.id, id);
  }

  @Post()
  @RequirePermissions(Permission.WITHDRAWALS_REQUEST)
  @ApiOperation({ summary: 'Ask for money out. The wallet is debited now.' })
  async request(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RequestWithdrawalDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<WithdrawalView> {
    return this.withdrawals.request({
      userId: user.id,
      walletId: body.walletId,
      amount: body.amount,
      destination: body.destination,
      idempotencyKey,
    });
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.WITHDRAWALS_REQUEST)
  @ApiOperation({ summary: 'Take a request back, while nobody has decided it' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<WithdrawalView> {
    return this.withdrawals.cancel({ userId: user.id, id, idempotencyKey });
  }
}
