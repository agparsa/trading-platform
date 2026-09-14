import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KycDocumentKind,
  KycStatus,
  MAX_DOCUMENT_BYTES,
  isCurrentlyVerified,
  isSubmittable,
  sniffContentType,
  submissionShortfalls,
} from '@tp/kyc-core';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { documentSealContext } from '@tp/crypto-core';
import { requireTenantId } from '@tp/tenancy';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { SecretBoxService } from '../common/crypto/crypto.module';

/** What the document's own row says. Never its bytes. */
export interface DocumentView {
  readonly id: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly filename: string | null;
  readonly uploadedAt: string;
  /** True once the retention sweep has cleared the bytes. */
  readonly purged: boolean;
  /** True if this document was uploaded after the last decision, i.e. it counts. */
  readonly current: boolean;
}

export interface KycView {
  readonly status: string;
  readonly reason: string | null;
  readonly submittedAt: string | null;
  readonly verifiedAt: string | null;
  readonly expiresAt: string | null;
  /** Whether a withdrawal gate would pass this person right now. */
  readonly verified: boolean;
  readonly canSubmit: boolean;
  /** What a submission is still missing, in words the person is shown. */
  readonly missing: readonly string[];
  readonly documents: readonly DocumentView[];
}

/**
 * The AAD every document is sealed under: its own row and nothing else.
 *
 * Defined in `sealed-columns.ts` and re-exported here, where readers of this
 * file expect it. The rotation job needs the same string, and an AAD with two
 * definitions is a column waiting to stop opening.
 */
export { documentSealContext };

/**
 * A person's identity verification, from their side.
 *
 * ## What this service never does
 *
 * It never logs a name, a document number, a filename or a byte. The logger is
 * given record ids and document kinds. A support engineer reading logs to find
 * out why an upload failed learns that a PASSPORT for record `…` was refused
 * for its size, and nothing about whose passport.
 *
 * It never returns document bytes. Reading a document is an operator's act
 * with its own capability and its own audit row; the person who uploaded it
 * has the original.
 *
 * It never decides. Verification is granted by somebody holding `kyc.review`,
 * or by a provider adapter when one is chosen; the person cannot advance their
 * own record past PENDING.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SecretBoxService) private readonly secrets: SecretBoxService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /** The record, created on first touch. A person always has one to look at. */
  private async ensure(userId: string) {
    const existing = await this.prisma.kycRecord.findFirst({ where: { userId } });
    if (existing !== null) return existing;
    try {
      return await this.prisma.kycRecord.create({
        data: { tenantId: requireTenantId(), userId },
      });
    } catch (error) {
      // Two first touches at once; the unique index picks one. See WalletService.ensure.
      const raced = await this.prisma.kycRecord.findFirst({ where: { userId } });
      if (raced === null) throw error;
      return raced;
    }
  }

  async view(userId: string): Promise<KycView> {
    const record = await this.ensure(userId);
    const documents = await this.prisma.kycDocument.findMany({
      where: { recordId: record.id },
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
    });

    const since = record.decidedAt;
    const views: DocumentView[] = documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      filename: document.filename,
      uploadedAt: document.uploadedAt.toISOString(),
      purged: document.purgedAt !== null,
      current: document.purgedAt === null && (since === null || document.uploadedAt > since),
    }));

    const status = record.status as KycStatus;
    const canSubmit = isSubmittable(status);
    const missing = canSubmit
      ? submissionShortfalls(
          views.filter((one) => one.current).map((one) => one.kind as KycDocumentKind),
        )
      : [];

    return {
      status,
      reason: record.reason,
      submittedAt: record.submittedAt?.toISOString() ?? null,
      verifiedAt: record.verifiedAt?.toISOString() ?? null,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      verified: this.isGood(record),
      canSubmit,
      missing,
      documents: views,
    };
  }

  /**
   * The gate. The one question a withdrawal asks.
   *
   * Judged from the policy, not only the column: `KYC_VALID_FOR_DAYS` is
   * honoured to the minute here, and the sweep that writes EXPIRED merely
   * catches the column up. A gate that trusted the column between two runs
   * would pass a verification the policy says has lapsed.
   */
  async isVerified(userId: string): Promise<boolean> {
    const record = await this.prisma.kycRecord.findFirst({ where: { userId } });
    return record !== null && this.isGood(record);
  }

  private isGood(record: { status: string; verifiedAt: Date | null }): boolean {
    const validForDays = this.config.get('KYC_VALID_FOR_DAYS', { infer: true }) ?? null;
    return isCurrentlyVerified(record.status as KycStatus, record.verifiedAt, validForDays);
  }

  /**
   * Stores one document, sealed.
   *
   * ## Order of checks
   *
   * The record's state first, so a person whose verification is under review
   * is told that rather than "file too large". Then the size, which is cheap.
   * Then the bytes are sniffed: what the client *said* the file was is not
   * consulted, because a client that wanted to store something other than a
   * document would say `image/png`.
   */
  async upload(input: {
    readonly userId: string;
    readonly kind: KycDocumentKind;
    readonly filename: string | null;
    readonly bytes: Buffer;
  }): Promise<DocumentView> {
    const record = await this.ensure(input.userId);
    const status = record.status as KycStatus;
    if (!isSubmittable(status)) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        status === KycStatus.VERIFIED
          ? 'Your identity is already verified.'
          : 'Your documents are being reviewed. Nothing more can be added until a decision is made.',
        { status },
      );
    }

    if (input.bytes.length === 0) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, 'The file is empty.');
    }
    if (input.bytes.length > MAX_DOCUMENT_BYTES) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `A document may be at most ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`,
        { sizeBytes: input.bytes.length, maximum: MAX_DOCUMENT_BYTES },
      );
    }

    const contentType = sniffContentType(input.bytes);
    if (contentType === null) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        'That file is not a JPEG, PNG, WebP or PDF. Photograph the document or export it as a PDF.',
      );
    }

    /**
     * The id is minted here rather than by the database, because the bytes are
     * sealed *to* it. Sealing first and inserting second needs the id to exist
     * before the row does, which is exactly this.
     */
    const id = randomUUID();
    const sealed = this.secrets.sealBytes(input.bytes, documentSealContext(id));
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');

    const created = await this.prisma.kycDocument.create({
      data: {
        id,
        tenantId: requireTenantId(),
        recordId: record.id,
        kind: input.kind,
        contentType,
        sha256,
        sizeBytes: input.bytes.length,
        filename: input.filename === null ? null : safeFilename(input.filename),
        // Prisma's Bytes wants a Uint8Array over a plain ArrayBuffer. A Buffer may
        // sit on a shared pool, so the sealed bytes are copied into their own.
        content: new Uint8Array(sealed),
        sealedWithKeyId: this.secrets.activeKeyId,
      },
      select: {
        id: true,
        kind: true,
        contentType: true,
        sizeBytes: true,
        filename: true,
        uploadedAt: true,
      },
    });

    await this.audit.record({
      actorId: input.userId,
      actorType: 'USER',
      action: 'kyc.document.uploaded',
      resourceType: 'KycDocument',
      resourceId: created.id,
      // Kind, size and hash, and nothing that identifies the person in it.
      after: {
        recordId: record.id,
        kind: created.kind,
        contentType,
        sizeBytes: created.sizeBytes,
        sha256,
      },
    });
    this.logger.log(`Document ${created.kind} stored for record ${record.id}`);

    return {
      id: created.id,
      kind: created.kind,
      contentType: created.contentType,
      sizeBytes: created.sizeBytes,
      filename: created.filename,
      uploadedAt: created.uploadedAt.toISOString(),
      purged: false,
      current: true,
    };
  }

  /**
   * Hands the documents over for review.
   *
   * Refused with every shortfall named at once, so a person is not sent round
   * the loop once per missing item. Moves the record to PENDING, which is the
   * first state an operator's queue shows.
   */
  async submit(userId: string): Promise<KycView> {
    const before = await this.view(userId);
    if (!before.canSubmit) {
      throw new DomainError(
        TradingErrorCode.INVALID_STATE_TRANSITION,
        before.status === KycStatus.VERIFIED
          ? 'Your identity is already verified.'
          : 'Your documents have already been submitted and are waiting for review.',
        { status: before.status },
      );
    }
    if (before.missing.length > 0) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Before submitting, add ${before.missing.join(' and ')}.`,
        { missing: before.missing.join('; ') },
      );
    }

    const record = await this.ensure(userId);
    const updated = await this.prisma.kycRecord.updateMany({
      where: { id: record.id, version: record.version },
      data: {
        status: KycStatus.PENDING,
        submittedAt: new Date(),
        reason: null,
        reviewerId: null,
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw new DomainError(
        TradingErrorCode.CONCURRENT_MODIFICATION,
        'Your verification changed while you were submitting. Reload and look again.',
      );
    }

    await this.audit.record({
      actorId: userId,
      actorType: 'USER',
      action: 'kyc.submitted',
      resourceType: 'KycRecord',
      resourceId: record.id,
      before: { status: record.status },
      after: { status: KycStatus.PENDING },
    });
    this.logger.log(`Record ${record.id} submitted for review`);

    return this.view(userId);
  }
}

/**
 * A filename the review screen can show without trusting it.
 *
 * Path separators go, control characters go, and it is cut to a length. It is
 * shown as text and never used to locate anything, so this is about display
 * rather than safety; but a filename of ten thousand characters is still a
 * nuisance.
 */
function safeFilename(raw: string): string | null {
  const cleaned = raw
    .split(/[\\/]/)
    .pop()
    ?.split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 120);
  return cleaned === undefined || cleaned.length === 0 ? null : cleaned;
}
