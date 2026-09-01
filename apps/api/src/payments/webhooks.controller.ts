import { Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithContext } from '../common/request-context';
import { Public } from '../common/decorators/public.decorator';
import { PaymentsService } from './payments.service';

/**
 * Where a payment provider tells us what happened.
 *
 * ## Public, and what that costs
 *
 * There is no session here — a provider has no account — so authenticity comes
 * from the signature over the raw body, which the adapter verifies because only
 * it knows the scheme. That is why the raw body is used rather than a
 * re-serialised object: a signature is over bytes, and `JSON.parse` followed by
 * `JSON.stringify` produces different bytes for the same document.
 *
 * ## Why it always answers 200
 *
 * A provider that gets anything else retries, for hours, with backoff — and a
 * wrong body or a bad signature will fail identically on every one of those
 * retries. Worse, a 4xx tells an unauthenticated caller which of "not for me"
 * and "not authentic" applied, which tells them how to get closer.
 *
 * So: accepted, recorded, and acted on if it is genuine. Everything the platform
 * decided is in `payment_events`, which is where an operator looks — not in a
 * status code the provider will never show anybody.
 */
@ApiTags('webhooks')
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  @ApiOperation({ summary: 'A payment provider reporting what happened' })
  async receive(
    @Param('provider') provider: string,
    @Req() request: RequestWithContext,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<{ received: true }> {
    const raw = (request as unknown as { rawBody?: Buffer }).rawBody;
    await this.payments.handleWebhook(provider, {
      headers,
      body: raw === undefined ? JSON.stringify(request.body ?? {}) : raw.toString('utf8'),
    });
    return { received: true };
  }
}
