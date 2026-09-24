import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { AdminWithdrawalsService, type AdminWithdrawalRow } from './admin-withdrawals.service';
import { DecideWithdrawalDto, SettlePayoutDto, StartPayoutDto } from './dto/withdrawals.dto';

/**
 * The finance desk.
 *
 * `withdrawals.read_any` sees the queue; `withdrawals.review` decides;
 * `withdrawals.pay` sends money and says so. The last two live in the FINANCE
 * role and nowhere near the capabilities that create money — see
 * INCOMPATIBLE_PERMISSIONS for why an ADMIN cannot approve a withdrawal.
 */
@ApiTags('admin')
@Controller('admin/withdrawals')
export class AdminWithdrawalsController {
  constructor(private readonly withdrawals: AdminWithdrawalsService) {}

  @Get()
  @RequirePermissions(Permission.WITHDRAWALS_READ_ANY)
  @ApiOperation({ summary: 'Withdrawals in flight, oldest first, or by status' })
  @ApiQuery({ name: 'status', required: false, type: String })
  async queue(
    @Query('status') status?: string,
  ): Promise<{ withdrawals: readonly AdminWithdrawalRow[] }> {
    return { withdrawals: await this.withdrawals.queue(status === undefined ? {} : { status }) };
  }

  @Get(':id')
  @RequirePermissions(Permission.WITHDRAWALS_READ_ANY)
  @ApiOperation({ summary: 'One withdrawal' })
  async one(@Param('id', ParseUUIDPipe) id: string): Promise<AdminWithdrawalRow> {
    return this.withdrawals.get(id);
  }

  /** The whole destination, for the person about to pay it. Audited. */
  @Get(':id/destination')
  @RequirePermissions(Permission.WITHDRAWALS_PAY)
  @ApiOperation({ summary: 'Where the money goes. Audited.' })
  async destination(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ destination: string }> {
    return this.withdrawals.openDestination({ id, actorId: actor.id });
  }

  @Post(':id/claim')
  @RequirePermissions(Permission.WITHDRAWALS_REVIEW)
  @ApiOperation({ summary: 'Take a request off the queue to review it' })
  async claim(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<AdminWithdrawalRow> {
    return this.withdrawals.claim({ id, actorId: actor.id });
  }

  @Post(':id/release')
  @RequirePermissions(Permission.WITHDRAWALS_REVIEW)
  @ApiOperation({ summary: 'Put a request back in the queue undecided' })
  async release(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<AdminWithdrawalRow> {
    return this.withdrawals.release({ id, actorId: actor.id });
  }

  @Post(':id/decide')
  @RequirePermissions(Permission.WITHDRAWALS_REVIEW)
  @ApiOperation({ summary: 'Approve, or reject with a reason (the money goes back)' })
  async decide(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideWithdrawalDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<AdminWithdrawalRow> {
    return this.withdrawals.decide({
      id,
      outcome: body.outcome,
      reason: body.reason,
      actorId: actor.id,
    });
  }

  @Post(':id/payout')
  @RequirePermissions(Permission.WITHDRAWALS_PAY)
  @ApiOperation({ summary: 'Record that the transfer has been sent, with its reference' })
  async startPayout(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StartPayoutDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<AdminWithdrawalRow> {
    return this.withdrawals.startPayout({
      id,
      providerReference: body.providerReference,
      actorId: actor.id,
    });
  }

  @Post(':id/settle')
  @RequirePermissions(Permission.WITHDRAWALS_PAY)
  @ApiOperation({
    summary: 'Record that the transfer went, or that it did not (the money goes back)',
  })
  async settle(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SettlePayoutDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<AdminWithdrawalRow> {
    return this.withdrawals.settle({
      id,
      outcome: body.outcome,
      reason: body.reason,
      actorId: actor.id,
    });
  }
}
