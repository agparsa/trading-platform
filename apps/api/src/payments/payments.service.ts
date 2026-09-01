import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { PaymentStatus, react, type WebhookDelivery } from '@tp/payments-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { ConfigService } from '@nestjs/config';
import { requireTenantId } from '@tp/tenancy';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../common/audit/audit.service';
import { PaymentProviders } from './payment-providers';

export interface IntentView {
  readonly id: string;
  readonly provider: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly instructions: string | null;
  readonly failureReason: string | null;
  readonly expiresAt: string;
  readonly settledAt: string | null;
  readonly createdAt: string;
}

/**
 * Money coming into the platform.
 *
 * ## The rule this phase was given
 *
 * *A failed payment must never create funds.* It is enforced in one place: the
 * wallet is credited on exactly one transition, into `SUCCEEDED`, and the state
 * machine in `@tp/payments-core` will not produce that transition twice or
 * produce it out of a terminal state. Everything else here is bookkeeping around
 * that single fact.
 *
 * ## Why a webhook cannot credit twice
 *
 * Two mechanisms, because either alone has a hole.
 *
 *   1. `payment_events(provider, provider_event_id)` is unique. A provider that
 *      re-delivers an event — after a timeout, after a retry, after its own
 *      outage — collides on the insert. A check in code could not do this: the
 *      two deliveries can be in flight on two API instances at the same moment,
 *      and only the database can settle that.
 *   2. The wallet credit carries an idempotency key derived from the intent id,
 *      so even a second event with a *different* id credits nothing.
 *
 * The first stops the ordinary case and the second stops the one where a
 * provider invents a new event id for a repeat.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WalletService) private readonly wallets: WalletService,
    @Inject(PaymentProviders) private readonly providers: PaymentProviders,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  async start(input: {
    readonly userId: string;
    readonly email: string;
    readonly provider: string;
    readonly amount: string;
    readonly currency: string;
  }): Promise<IntentView> {
    const provider = this.providers.require(input.provider);
    const currency = input.currency.toUpperCase();
    if (!provider.supports(currency)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `${provider.name} does not take ${currency}.`,
        { provider: provider.name, currency },
      );
    }

    const amount = Money.of(input.amount, currency);
    if (!amount.isPositive()) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, 'A deposit must be positive.');
    }
    const ceiling = Money.of(this.config.get('PAYMENT_MAX_AMOUNT', { infer: true }), currency);
    if (amount.gt(ceiling)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `The largest deposit this platform will start is ${ceiling.toString()} ${currency}. ` +
          'Split it, or talk to us about a larger transfer.',
        { maximum: ceiling.toString() },
      );
    }

    const hours = this.config.get('PAYMENT_INTENT_TTL_HOURS', { infer: true });
    const expiresAt = new Date(Date.now() + hours * 3600_000);

    /**
     * The row is created before the provider is called, so that the reference
     * the payer is told to quote is one that already exists here. A provider
     * that returned an id for a payment this platform had not recorded would be
     * a payment nobody could match afterwards.
     */
    const intent = await this.prisma.paymentIntent.create({
      data: {
        tenantId: requireTenantId(),
        userId: input.userId,
        provider: provider.name,
        amount: amount.toString(),
        currency,
        expiresAt,
      },
    });

    const instruction = await provider.begin({
      reference: intent.id,
      amount: amount.toString(),
      currency,
      payer: { userId: input.userId, email: input.email },
    });

    const updated = await this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: instruction.status,
        instructions: instruction.instructions ?? instruction.redirectUrl ?? null,
        providerReference: instruction.providerReference ?? null,
      },
    });

    await this.audit.record({
      actorId: input.userId,
      actorType: 'USER',
      action: 'payment.started',
      resourceType: 'PaymentIntent',
      resourceId: intent.id,
      after: { provider: provider.name, amount: amount.toString(), currency },
    });

    return view(updated);
  }

  async listFor(userId: string, limit = 50): Promise<readonly IntentView[]> {
    const rows = await this.prisma.paymentIntent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(view);
  }

  async get(userId: string, id: string): Promise<IntentView> {
    const intent = await this.prisma.paymentIntent.findFirst({ where: { id } });
    if (intent === null || intent.userId !== userId) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such payment');
    }
    return view(intent);
  }

  /**
   * Handles one webhook delivery.
   *
   * Returns quietly for anything the adapter does not recognise, including a bad
   * signature. The caller answers 200 either way, deliberately: a provider that
   * gets a 4xx will retry for hours, and telling an unauthenticated caller which
   * of "not mine" and "not authentic" applied tells them how to get closer.
   */
  async handleWebhook(providerName: string, delivery: WebhookDelivery): Promise<void> {
    const provider = this.providers.find(providerName);
    if (provider === undefined) {
      this.logger.warn(`Webhook for unknown provider ${providerName}; ignored`);
      return;
    }

    const event = await provider.parseWebhook(delivery);
    if (event === null) {
      this.logger.warn(`Webhook from ${providerName} was not recognised or not authentic`);
      return;
    }

    await this.apply(provider.name, event);
  }

  /**
   * Applies one provider event to its intent.
   *
   * Shared by the webhook path and by an operator confirming a bank transfer, so
   * there is one place where a payment becomes money.
   */
  async apply(
    providerName: string,
    event: {
      readonly eventId: string;
      readonly reference: string;
      readonly status: PaymentStatus;
      readonly providerStatus: string;
      readonly providerReference?: string;
      readonly amount?: string;
      readonly currency?: string;
    },
  ): Promise<void> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id: event.reference, provider: providerName },
    });
    if (intent === null) {
      this.logger.warn(
        `${providerName} reported ${event.providerStatus} for reference ${event.reference}, which is not a payment here`,
      );
      return;
    }

    /**
     * A provider that states an amount must state *this* amount.
     *
     * Not a formality: an event matched to the wrong intent, or an intent whose
     * amount was edited after it was created, both show up here — and both would
     * otherwise credit whatever the provider said.
     */
    if (event.amount !== undefined) {
      const reported = Money.of(event.amount, event.currency ?? intent.currency);
      const expected = Money.of(intent.amount.toString(), intent.currency);
      if (!reported.equals(expected)) {
        await this.recordEvent(intent, providerName, event, 'alarm', {
          note: `reported ${reported.toString()} for a payment of ${expected.toString()}`,
        });
        this.logger.error(
          `${providerName} reported ${reported.toString()} for payment ${intent.id}, which is for ${expected.toString()}. Nothing was credited.`,
        );
        return;
      }
    }

    const reaction = react(intent.status as PaymentStatus, event.status);

    if (reaction.kind === 'ignore') {
      await this.recordEvent(intent, providerName, event, 'ignore', { note: reaction.why });
      return;
    }

    if (reaction.kind === 'alarm') {
      await this.recordEvent(intent, providerName, event, 'alarm', { note: reaction.why });
      /**
       * Loud, and nothing else. A settled payment does not un-settle: if this is
       * a genuine reversal it is a chargeback, which is a separate movement with
       * its own accounting, and silently debiting a wallet from a webhook is how
       * money disappears with no record of a decision.
       */
      this.logger.error(
        `${providerName} reported ${event.providerStatus} for payment ${intent.id}: ${reaction.why}`,
      );
      return;
    }

    await this.settle(intent, providerName, event, reaction.to);
  }

  private async settle(
    intent: {
      id: string;
      userId: string;
      amount: Prisma.Decimal;
      currency: string;
      status: string;
    },
    providerName: string,
    event: {
      readonly eventId: string;
      readonly providerStatus: string;
      readonly providerReference?: string;
      readonly status: PaymentStatus;
      readonly reference: string;
    },
    to: PaymentStatus,
  ): Promise<void> {
    const credits = to === PaymentStatus.SUCCEEDED;
    const wallet = credits ? await this.wallets.ensure(intent.userId, intent.currency) : undefined;

    await this.prisma.$transaction(async (tx) => {
      /**
       * The event row first, inside the same transaction as the credit.
       *
       * Its unique `(provider, provider_event_id)` is what makes a re-delivery
       * harmless: the second one fails here, before any money moves, and the
       * whole transaction rolls back. Recording it afterwards would leave a
       * window in which two deliveries both credited.
       */
      await tx.paymentEvent.create({
        data: {
          tenantId: requireTenantId(),
          intentId: intent.id,
          provider: providerName,
          providerEventId: event.eventId,
          providerStatus: event.providerStatus,
          status: event.status,
          outcome: 'apply',
        },
      });

      let walletTransactionId: string | null = null;
      if (wallet !== undefined) {
        const movement = await this.wallets.post(tx, {
          walletId: wallet.id,
          type: 'DEPOSIT',
          amount: Money.of(intent.amount.toString(), intent.currency),
          referenceType: 'PaymentIntent',
          referenceId: intent.id,
          // The second guard: even an event with a new id credits once.
          idempotencyKey: `payment:${intent.id}`,
          description: `Deposit via ${providerName}`,
        });
        walletTransactionId = movement.transactionId;
      }

      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          status: to,
          ...(event.providerReference === undefined
            ? {}
            : { providerReference: event.providerReference }),
          ...(walletTransactionId === null ? {} : { walletTransactionId }),
          ...(to === PaymentStatus.SUCCEEDED ? { settledAt: new Date() } : {}),
          ...(to === PaymentStatus.FAILED ? { failureReason: event.providerStatus } : {}),
        },
      });

      await this.audit.record(
        {
          actorId: null,
          actorType: 'SYSTEM',
          action: `payment.${to.toLowerCase()}`,
          resourceType: 'PaymentIntent',
          resourceId: intent.id,
          before: { status: intent.status },
          after: {
            status: to,
            provider: providerName,
            providerStatus: event.providerStatus,
            amount: intent.amount.toString(),
            currency: intent.currency,
            ...(walletTransactionId === null ? {} : { walletTransactionId }),
          },
        },
        tx,
      );
    });
  }

  private async recordEvent(
    intent: { id: string },
    providerName: string,
    event: {
      readonly eventId: string;
      readonly providerStatus: string;
      readonly status: PaymentStatus;
    },
    outcome: 'ignore' | 'alarm',
    extra: { readonly note: string },
  ): Promise<void> {
    try {
      await this.prisma.paymentEvent.create({
        data: {
          tenantId: requireTenantId(),
          intentId: intent.id,
          provider: providerName,
          providerEventId: event.eventId,
          providerStatus: event.providerStatus,
          status: event.status,
          outcome,
          note: extra.note,
        },
      });
    } catch (error) {
      /**
       * A duplicate event id means this delivery was already recorded, which is
       * the constraint doing its job. Anything else is a real failure and is
       * logged: an event this platform decided to ignore, and then failed to
       * write down, is an event nobody can audit afterwards.
       */
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return;
      }
      this.logger.error(
        `Failed to record the ${outcome} of ${providerName} event ${event.eventId} for payment ${intent.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

function view(intent: {
  id: string;
  provider: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  instructions: string | null;
  failureReason: string | null;
  expiresAt: Date;
  settledAt: Date | null;
  createdAt: Date;
}): IntentView {
  return {
    id: intent.id,
    provider: intent.provider,
    amount: Money.of(intent.amount.toString(), intent.currency).toString(),
    currency: intent.currency,
    status: intent.status,
    instructions: intent.instructions,
    failureReason: intent.failureReason,
    expiresAt: intent.expiresAt.toISOString(),
    settledAt: intent.settledAt?.toISOString() ?? null,
    createdAt: intent.createdAt.toISOString(),
  };
}
