import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Money } from '@tp/financial-core';
import { PaymentStatus } from '@tp/payments-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { PaymentsService } from './payments.service';

export interface AdminIntentView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly provider: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

@Injectable()
export class AdminPaymentsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(query: {
    status?: string;
    userId?: string;
    limit?: number;
  }): Promise<readonly AdminIntentView[]> {
    const where: Prisma.PaymentIntentWhereInput = {};
    if (query.status !== undefined) {
      // Checked against the enum rather than cast into it: a status a client
      // invented should be a refusal, not a silent empty list.
      const known = Object.values(PaymentStatus) as string[];
      if (!known.includes(query.status)) {
        throw new DomainError(
          TradingErrorCode.VALIDATION_FAILED,
          `No payment status called ${query.status}. Try one of: ${known.join(', ')}.`,
        );
      }
      where.status = query.status as Prisma.PaymentIntentWhereInput['status'];
    }
    if (query.userId !== undefined) where.userId = query.userId;

    const rows = await this.prisma.paymentIntent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 100, 1), 200),
      include: { user: { select: { email: true } } },
    });
    return rows.map(toView);
  }

  async events(intentId: string): Promise<readonly unknown[]> {
    return this.prisma.paymentEvent.findMany({
      where: { intentId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * An operator settling a payment that has no webhook.
   *
   * It goes through the same `apply` the webhook path uses, so there is exactly
   * one place where a payment becomes money and exactly one state machine
   * deciding whether it may. The operator's identity travels in the event id,
   * which is also what makes the action idempotent: pressing confirm twice
   * collides on `(provider, provider_event_id)` and credits once.
   */
  async settleByHand(input: {
    readonly intentId: string;
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    readonly reason: string;
    readonly actorId: string;
    readonly idempotencyKey: string;
  }): Promise<AdminIntentView> {
    const intent = await this.prisma.paymentIntent.findFirst({ where: { id: input.intentId } });
    if (intent === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such payment');
    }

    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'payment.settled_by_hand',
      resourceType: 'PaymentIntent',
      resourceId: intent.id,
      before: { status: intent.status },
      after: {
        outcome: input.outcome,
        reason: input.reason,
        amount: intent.amount.toString(),
        currency: intent.currency,
      },
    });

    await this.payments.apply(intent.provider, {
      eventId: `manual:${input.idempotencyKey}`,
      reference: intent.id,
      status: input.outcome as PaymentStatus,
      providerStatus: `confirmed by an operator: ${input.reason}`,
    });

    const after = await this.prisma.paymentIntent.findFirstOrThrow({
      where: { id: intent.id },
      include: { user: { select: { email: true } } },
    });
    return toView(after);
  }
}

function toView(row: {
  id: string;
  userId: string;
  user: { email: string };
  provider: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  failureReason: string | null;
  createdAt: Date;
  settledAt: Date | null;
}): AdminIntentView {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    provider: row.provider,
    amount: Money.of(row.amount.toString(), row.currency).toString(),
    currency: row.currency,
    status: row.status,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  };
}
