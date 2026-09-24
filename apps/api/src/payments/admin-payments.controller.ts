import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { AdminPaymentsService, type AdminIntentView } from './admin-payments.service';
import { SettlePaymentDto } from './dto/payments.dto';

/**
 * The queue of payments waiting for a person.
 *
 * A bank transfer has no webhook — nobody is going to send one — so somebody
 * here matches a line on a statement to a reference and says so. That is a
 * capability of its own: it credits a wallet, and no role may hold it alongside
 * the ability to open a position.
 *
 * It is narrower than `wallet.adjust` on purpose. This can settle only a payment
 * somebody started, only for the amount they started it for, and it leaves an
 * intent and an event behind. `wallet.adjust` can credit any wallet any amount.
 * Both make money appear; only one of them has a counterparty.
 */
@ApiTags('admin')
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly payments: AdminPaymentsService) {}

  @Get()
  @RequirePermissions(Permission.PAYMENTS_READ_ANY)
  @ApiOperation({ summary: 'Payments, newest first, optionally by status' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'userId', required: false, type: String })
  async list(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
  ): Promise<{ payments: readonly AdminIntentView[] }> {
    return {
      payments: await this.payments.list({
        ...(status === undefined ? {} : { status }),
        ...(userId === undefined ? {} : { userId }),
      }),
    };
  }

  @Get(':id/events')
  @RequirePermissions(Permission.PAYMENTS_READ_ANY)
  @ApiOperation({ summary: 'Everything a provider has said about one payment' })
  async events(@Param('id', ParseUUIDPipe) id: string): Promise<{ events: readonly unknown[] }> {
    return { events: await this.payments.events(id) };
  }

  /**
   * Confirms or rejects a payment a person had to settle.
   *
   * The amount is not a parameter. It is the amount on the intent, which is what
   * the payer was told to send — an operator who could type a different number
   * would be able to credit any amount against any payment, which is
   * `wallet.adjust` wearing a narrower name.
   */
  @Post(':id/settle')
  @RequirePermissions(Permission.PAYMENTS_CONFIRM)
  @ApiOperation({ summary: 'Confirm or reject a payment by hand' })
  async settle(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SettlePaymentDto,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<AdminIntentView> {
    return this.payments.settleByHand({
      intentId: id,
      outcome: body.outcome,
      reason: body.reason,
      actorId: actor.id,
      idempotencyKey,
    });
  }
}
