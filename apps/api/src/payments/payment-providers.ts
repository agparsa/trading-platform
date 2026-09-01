import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { ConfigService } from '@nestjs/config';
import type { PaymentProvider } from '@tp/payments-core';
import type { Env } from '../config/env.schema';
import { ManualBankTransferProvider } from './providers/manual-bank-transfer.provider';

/**
 * Which payment providers this deployment has.
 *
 * ## The gap, stated rather than filled
 *
 * There is one provider here and it is the manual one. Choosing a third-party
 * processor is a commercial decision — pricing, settlement terms, which
 * countries, which methods — and the implementation plan says so: it gates this
 * phase. An adapter written against documentation for a contract nobody has
 * signed would be an integration that has never taken a payment, sitting in the
 * repository looking finished.
 *
 * So `PaymentProvider` exists, the state machine and the webhook plumbing are
 * real and tested, and the concrete adapter is **pending provider selection**.
 * Adding one means implementing that interface and registering it here; nothing
 * else in the platform should have to change, which is the point of the port.
 */
@Injectable()
export class PaymentProviders {
  private readonly logger = new Logger(PaymentProviders.name);
  private readonly byName = new Map<string, PaymentProvider>();

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    const currencies = config
      .get('PAYMENT_CURRENCIES', { infer: true })
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => code.length === 3);

    const manual = new ManualBankTransferProvider(
      config.get('PAYMENT_BANK_DETAILS', { infer: true }),
      currencies,
    );
    this.byName.set(manual.name, manual);

    this.logger.log(
      `Payment providers: ${[...this.byName.keys()].join(', ')} (currencies: ${currencies.join(', ')})`,
    );
  }

  get names(): readonly string[] {
    return [...this.byName.keys()];
  }

  /** The provider by name, or a refusal naming what this deployment has. */
  require(name: string): PaymentProvider {
    const provider = this.byName.get(name);
    if (provider === undefined) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `No payment provider called ${name}. This deployment has: ${this.names.join(', ')}.`,
        { provider: name },
      );
    }
    return provider;
  }

  /** For a webhook, which may name a provider this deployment does not have. */
  find(name: string): PaymentProvider | undefined {
    return this.byName.get(name);
  }
}
