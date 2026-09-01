import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycStatus, canTransition, isAwaitingDecision } from '@tp/kyc-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { SecretDecryptionError } from '@tp/crypto-core';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { SecretBoxService } from '../common/crypto/crypto.module';
import { NotificationsService } from '../notifications/notifications.service';
import { documentSealContext, type DocumentView } from './kyc.service';

export interface QueueRow {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly status: string;
  readonly submittedAt: string | null;
  readonly reviewerId: string | null;
  readonly decidedAt: string | null;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  readonly reason: string | null;
  /** Kinds on the current attempt, so a queue row says what is inside without opening it. */
  readonly documentKinds: readonly string[];
}

export interface RecordDetail extends QueueRow {
  readonly provider: string;
  readonly documents: readonly DocumentView[];
}

/**
 * Identity verification, as an operator works it.
 *
 * ## Two capabilities, and why reading a document is not reading a record
 *
 * `kyc.read_any` shows the queue and every record's status. `kyc.documents.read`
 * opens the sealed bytes. They are different powers: a support agent answering
 * "why can't I withdraw" needs the first and must not have the second, or every
 * passport on the platform is one support ticket away.
 *
 * Every opening of a document writes an audit row with the operator's name on
 * it. That is not a formality: it is the only record of who has seen whose
 * identity, and the one thing a data-protection inquiry asks for first.
 *
 * ## What the reviewer cannot do
 *
 * Reject a verification already granted. That is `revoke`, a separate act with
 * its own reason and its own audit action, because a review decision rewritten
 * after the fact is a trail that shows a rejection with no review behind it.
 */
@Injectable()
export class AdminKycService {
  private readonly logger = new Logger(AdminKycService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecretBoxService) private readonly secrets: SecretBoxService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  async queue(input: { status?: string; limit?: number }): Promise<readonly QueueRow[]> {
    const known = Object.values(KycStatus) as string[];
    if (input.status !== undefined && !known.includes(input.status)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `No verification status called ${input.status}. Try one of: ${known.join(', ')}.`,
      );
    }

    const rows = await this.prisma.kycRecord.findMany({
      where:
        input.status === undefined
          ? { status: { in: [KycStatus.PENDING, KycStatus.UNDER_REVIEW] } }
          : { status: input.status as KycStatus },
      // Oldest submission first: a queue is worked in the order people joined it.
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(Math.max(input.limit ?? 100, 1), 200),
      include: {
        user: { select: { email: true } },
        documents: { select: { kind: true, uploadedAt: true, purgedAt: true } },
      },
    });
    return rows.map((row) => toQueueRow(row));
  }

  async get(recordId: string): Promise<RecordDetail> {
    const record = await this.prisma.kycRecord.findFirst({
      where: { id: recordId },
      include: {
        user: { select: { email: true } },
        documents: {
          orderBy: { uploadedAt: 'asc' },
          select: {
            id: true,
            kind: true,
            contentType: true,
            sizeBytes: true,
            filename: true,
            uploadedAt: true,
            purgedAt: true,
          },
        },
      },
    });
    if (record === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such verification');
    }
    const since = record.decidedAt;
    return {
      ...toQueueRow(record),
      provider: record.provider,
      documents: record.documents.map((document) => ({
        id: document.id,
        kind: document.kind,
        contentType: document.contentType,
        sizeBytes: document.sizeBytes,
        filename: document.filename,
        uploadedAt: document.uploadedAt.toISOString(),
        purged: document.purgedAt !== null,
        current: document.purgedAt === null && (since === null || document.uploadedAt > since),
      })),
    };
  }

  /**
   * Opens one document for a reviewer.
   *
   * The audit row is written *before* the bytes are returned, in the same
   * breath. A view that failed to be recorded is a view that did not happen,
   * which is the wrong way round for an identity document: if the audit write
   * fails, this throws, and the reviewer sees nothing.
   */
  async openDocument(input: {
    readonly recordId: string;
    readonly documentId: string;
    readonly actorId: string;
  }): Promise<{ contentType: string; bytes: Buffer; filename: string | null }> {
    const document = await this.prisma.kycDocument.findFirst({
      where: { id: input.documentId, recordId: input.recordId },
    });
    if (document === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such document');
    }
    if (document.content === null) {
      throw new DomainError(
        TradingErrorCode.RESOURCE_NOT_FOUND,
        `This document was purged on ${document.purgedAt?.toISOString() ?? 'an unknown date'} under the retention policy. Its kind, size and hash remain on the record.`,
        { purgedAt: document.purgedAt?.toISOString() ?? null },
      );
    }

    // Written with a transaction client so a failure throws rather than logs.
    await this.prisma.$transaction((tx) =>
      this.audit.record(
        {
          actorId: input.actorId,
          actorType: 'ADMIN',
          action: 'kyc.document.viewed',
          resourceType: 'KycDocument',
          resourceId: document.id,
          after: { recordId: document.recordId, kind: document.kind },
        },
        tx,
      ),
    );

    let bytes: Buffer;
    try {
      bytes = this.secrets.openBytes(
        Buffer.from(document.content),
        documentSealContext(document.id),
      );
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        // Named by id and kind only. A document that will not open is an
        // operational fault — a retired key, a copied row — and the log must
        // say so without saying whose it was.
        this.logger.error(
          `Document ${document.id} (${document.kind}) could not be opened: ${error.message}`,
        );
        throw new DomainError(
          TradingErrorCode.INTERNAL_ERROR,
          'This document cannot be opened. The sealing key it was written under may have been retired; see docs/encryption-at-rest.md.',
        );
      }
      throw error;
    }

    return { contentType: document.contentType, bytes, filename: document.filename };
  }

  /** Takes a record off the queue and onto one reviewer's desk. */
  async claim(input: { recordId: string; actorId: string }): Promise<RecordDetail> {
    const record = await this.requireRecord(input.recordId);
    if (record.status === KycStatus.UNDER_REVIEW && record.reviewerId === input.actorId) {
      return this.get(record.id);
    }
    this.requireTransition(record.status as KycStatus, KycStatus.UNDER_REVIEW);

    await this.move(record, {
      status: KycStatus.UNDER_REVIEW,
      reviewerId: input.actorId,
    });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'kyc.review.started',
      resourceType: 'KycRecord',
      resourceId: record.id,
      before: { status: record.status, reviewerId: record.reviewerId },
      after: { status: KycStatus.UNDER_REVIEW, reviewerId: input.actorId },
    });
    return this.get(record.id);
  }

  /** Puts a record back in the queue without deciding it. */
  async release(input: { recordId: string; actorId: string }): Promise<RecordDetail> {
    const record = await this.requireRecord(input.recordId);
    this.requireTransition(record.status as KycStatus, KycStatus.PENDING);

    await this.move(record, { status: KycStatus.PENDING, reviewerId: null });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'kyc.review.released',
      resourceType: 'KycRecord',
      resourceId: record.id,
      before: { status: record.status, reviewerId: record.reviewerId },
      after: { status: KycStatus.PENDING, reviewerId: null },
    });
    return this.get(record.id);
  }

  /**
   * The decision.
   *
   * Version-guarded, so two reviewers deciding the same record at once produce
   * one decision and one refusal rather than a status that depends on who
   * committed last. The person is told either way, with the reason if refused.
   */
  async decide(input: {
    readonly recordId: string;
    readonly outcome: 'VERIFIED' | 'REJECTED';
    readonly reason: string;
    readonly actorId: string;
  }): Promise<RecordDetail> {
    const record = await this.requireRecord(input.recordId);
    if (!isAwaitingDecision(record.status as KycStatus)) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        `This verification is ${record.status}, not waiting for a decision.`,
        { status: record.status },
      );
    }
    this.requireTransition(record.status as KycStatus, input.outcome);

    const now = new Date();
    const validForDays = this.config.get('KYC_VALID_FOR_DAYS', { infer: true }) ?? null;
    const expiresAt =
      input.outcome === KycStatus.VERIFIED && validForDays !== null
        ? new Date(now.getTime() + validForDays * 86_400_000)
        : null;

    await this.move(record, {
      status: input.outcome,
      reason: input.outcome === KycStatus.REJECTED ? input.reason : null,
      reviewerId: null,
      decidedById: input.actorId,
      decidedAt: now,
      verifiedAt: input.outcome === KycStatus.VERIFIED ? now : null,
      expiresAt,
    });

    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: input.outcome === KycStatus.VERIFIED ? 'kyc.verified' : 'kyc.rejected',
      resourceType: 'KycRecord',
      resourceId: record.id,
      before: { status: record.status },
      after: {
        status: input.outcome,
        reason: input.reason,
        ...(expiresAt === null ? {} : { expiresAt: expiresAt.toISOString() }),
      },
    });
    this.logger.log(`Record ${record.id} ${input.outcome.toLowerCase()}`);

    await this.notifications.raise({
      userId: record.userId,
      kind: input.outcome === KycStatus.VERIFIED ? 'kyc.verified' : 'kyc.rejected',
      severity: 'INFO',
      title:
        input.outcome === KycStatus.VERIFIED
          ? 'Your identity has been verified'
          : 'Your identity documents were not accepted',
      body:
        input.outcome === KycStatus.VERIFIED
          ? expiresAt === null
            ? 'Withdrawals are open to you.'
            : `Withdrawals are open to you. This verification is valid until ${expiresAt.toISOString().slice(0, 10)}.`
          : `${input.reason} You can submit again from the Verification page.`,
      dedupeKey: `kyc:${record.id}:${input.outcome}:${now.getTime()}`,
    });

    return this.get(record.id);
  }

  /**
   * Withdraws a verification already granted.
   *
   * Not a rejection. A rejection is a review decision about a submission; this
   * is a later finding about a person, and the record goes back to the start
   * rather than to REJECTED so that the trail does not show a review that never
   * happened. The person is told, with the reason.
   */
  async revoke(input: {
    readonly recordId: string;
    readonly reason: string;
    readonly actorId: string;
  }): Promise<RecordDetail> {
    const record = await this.requireRecord(input.recordId);
    this.requireTransition(record.status as KycStatus, KycStatus.NOT_STARTED);

    await this.move(record, {
      status: KycStatus.NOT_STARTED,
      reason: input.reason,
      reviewerId: null,
      decidedById: input.actorId,
      decidedAt: new Date(),
      verifiedAt: null,
      expiresAt: null,
    });
    await this.audit.record({
      actorId: input.actorId,
      actorType: 'ADMIN',
      action: 'kyc.revoked',
      resourceType: 'KycRecord',
      resourceId: record.id,
      before: { status: record.status, verifiedAt: record.verifiedAt?.toISOString() ?? null },
      after: { status: KycStatus.NOT_STARTED, reason: input.reason },
    });
    this.logger.warn(`Record ${record.id} verification revoked`);

    await this.notifications.raise({
      userId: record.userId,
      kind: 'kyc.revoked',
      severity: 'WARNING',
      title: 'Your identity verification has been withdrawn',
      body: `${input.reason} Withdrawals are paused until you verify again.`,
    });

    return this.get(record.id);
  }

  private async requireRecord(recordId: string) {
    const record = await this.prisma.kycRecord.findFirst({ where: { id: recordId } });
    if (record === null) {
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such verification');
    }
    return record;
  }

  private requireTransition(from: KycStatus, to: KycStatus): void {
    if (!canTransition(from, to)) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        `A verification that is ${from} cannot become ${to}.`,
        { from, to },
      );
    }
  }

  /** One version-guarded write. Every state change goes through here. */
  private async move(
    record: { id: string; version: number },
    data: {
      status: KycStatus;
      reviewerId?: string | null;
      reason?: string | null;
      decidedById?: string | null;
      decidedAt?: Date | null;
      verifiedAt?: Date | null;
      expiresAt?: Date | null;
    },
  ): Promise<void> {
    const updated = await this.prisma.kycRecord.updateMany({
      where: { id: record.id, version: record.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new DomainError(
        TradingErrorCode.CONCURRENT_MODIFICATION,
        'Somebody else changed this verification first. Reload and look again.',
      );
    }
  }
}

function toQueueRow(row: {
  id: string;
  userId: string;
  user: { email: string };
  status: string;
  submittedAt: Date | null;
  reviewerId: string | null;
  decidedAt: Date | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  reason: string | null;
  documents: ReadonlyArray<{ kind: string; uploadedAt: Date; purgedAt: Date | null }>;
}): QueueRow {
  const since = row.decidedAt;
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    status: row.status,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewerId: row.reviewerId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    reason: row.reason,
    documentKinds: [
      ...new Set(
        row.documents
          .filter((one) => one.purgedAt === null && (since === null || one.uploadedAt > since))
          .map((one) => one.kind),
      ),
    ],
  };
}
