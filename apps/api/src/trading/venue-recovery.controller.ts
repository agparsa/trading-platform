import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { ExternalExecutionService } from './external-execution.service';
import { VenueRecoveryService, type RecoverySummary } from './venue-recovery.service';

/**
 * The console for orders whose answers were lost.
 *
 * The sweep runs on its own and this exists for the case it cannot settle: a
 * venue that has been unreachable for an hour, an order that has been waiting
 * since. Someone needs to be able to see that list and to ask again now.
 *
 * There is deliberately no route that *decides* an order's fate. A person
 * cannot mark an unconfirmed order filled or cancelled here, because that is
 * the venue's answer to give and guessing it is how a platform books a
 * position the venue does not hold. The only verb is "ask again".
 */
@ApiTags('venue-recovery')
@Controller('admin/venue-recovery')
@SessionOnly()
export class VenueRecoveryController {
  constructor(
    private readonly external: ExternalExecutionService,
    private readonly recovery: VenueRecoveryService,
  ) {}

  /**
   * `ACCOUNTS_READ_ANY`, not `ORDERS_READ`.
   *
   * Every trader holds `ORDERS_READ` — it is what lets them see their own
   * orders. This list is every account's, so it needs the permission that
   * means "read across accounts". Guarding it by the weaker one would have
   * shown one trader another's order ids and account ids.
   */
  @Get('unconfirmed')
  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @ApiOperation({ summary: 'Orders still waiting on a venue’s answer, oldest first' })
  async unconfirmed(): Promise<{
    orders: readonly { id: string; clientOrderId: string | null; accountId: string; createdAt: Date }[];
  }> {
    return { orders: await this.external.unconfirmed() };
  }

  @Post('run')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({ summary: 'Ask every venue now about every order still waiting' })
  run(@IdempotencyKey() _idempotencyKey: string): Promise<RecoverySummary> {
    return this.recovery.run();
  }

  /**
   * Asking a venue reaches out of this platform on the firm's credentials, so
   * it takes the permission that governs those — which is also person-only,
   * keeping a stolen API key from driving a venue conversation.
   */
  @Post('unconfirmed/:orderId/resolve')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({
    summary: 'Ask the venue about one order. It asks; it never resends and never guesses.',
  })
  async resolve(
    @CurrentUser() _actor: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<{ resolved: boolean; status: string | null; reason: string | null }> {
    const outcome = await this.external.resolveUnconfirmed(orderId);
    if (outcome === null) {
      // Not unconfirmed any more, or not an order this firm holds. Either way
      // there is nothing to ask about, and that is not an error.
      return { resolved: false, status: null, reason: null };
    }
    return { resolved: true, status: outcome.status, reason: outcome.reason ?? null };
  }
}
