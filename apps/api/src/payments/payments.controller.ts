import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { PaymentsService, type IntentView } from './payments.service';
import { PaymentProviders } from './payment-providers';
import { StartPaymentDto } from './dto/payments.dto';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly providers: PaymentProviders,
  ) {}

  /**
   * What this deployment can take money through.
   *
   * Read from the registry rather than written down, so a client cannot offer a
   * provider the server does not have — and so that a deployment with only the
   * manual one shows only that, honestly.
   */
  @Get('providers')
  @RequirePermissions(Permission.PAYMENTS_READ)
  @ApiOperation({ summary: 'Payment providers this deployment has' })
  available(): { providers: readonly string[] } {
    return { providers: this.providers.names };
  }

  @Get()
  @RequirePermissions(Permission.PAYMENTS_READ)
  @ApiOperation({ summary: 'Your deposits' })
  async mine(@CurrentUser() user: AuthenticatedUser): Promise<{ payments: readonly IntentView[] }> {
    return { payments: await this.payments.listFor(user.id) };
  }

  @Get(':id')
  @RequirePermissions(Permission.PAYMENTS_READ)
  @ApiOperation({ summary: 'One of your deposits' })
  async one(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IntentView> {
    return this.payments.get(user.id, id);
  }

  /**
   * Starts a deposit and returns what the payer must do next.
   *
   * Nothing is credited here. The money appears when the provider says it has —
   * or, for a bank transfer, when somebody here has matched it to this payment's
   * reference. A screen that showed a balance rising the moment a form was
   * submitted would be showing money that does not exist.
   */
  @Post()
  @RequirePermissions(Permission.PAYMENTS_CREATE)
  @ApiOperation({ summary: 'Start a deposit' })
  async start(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: StartPaymentDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<IntentView> {
    return this.payments.start({
      userId: user.id,
      email: user.email,
      provider: body.provider,
      amount: body.amount,
      currency: body.currency,
    });
  }
}
