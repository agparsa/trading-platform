import { Controller, Get, Headers, Param, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ACCEPTED_CONTENT_TYPES, KycDocumentKind, MAX_DOCUMENT_BYTES } from '@tp/kyc-core';
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import type { RequestWithContext } from '../common/request-context';
import { KycService, type DocumentView, type KycView } from './kyc.service';
import { documentKindSchema } from './dto/kyc.dto';

/**
 * A person's own verification.
 *
 * ## Why the upload is a raw body and not a form
 *
 * `PUT /kyc/documents/:kind` takes the file as the request body, with its
 * content type in the header and its name in `X-Filename`. No multipart, no
 * temporary files, no parsing library between the bytes and the sniffer that
 * decides what they are. A phone can send it with one `fetch`, and the size
 * limit is enforced by the raw-body parser before a byte reaches this class.
 *
 * The declared content type is used only to *route* the body to the raw parser.
 * What the file actually is comes from its bytes, in the service.
 */
@ApiTags('kyc')
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @RequirePermissions(Permission.KYC_READ)
  @ApiOperation({ summary: 'Your verification, and what it still needs' })
  async mine(@CurrentUser() user: AuthenticatedUser): Promise<KycView> {
    return this.kyc.view(user.id);
  }

  @Put('documents/:kind')
  @RequirePermissions(Permission.KYC_SUBMIT)
  @ApiOperation({ summary: 'Upload one document, as the request body' })
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') rawKind: string,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-filename') filename: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DocumentView> {
    const kind = documentKindSchema.safeParse(rawKind.toUpperCase());
    if (!kind.success) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `No document kind called ${rawKind}. Try one of: ${Object.values(KycDocumentKind).join(', ')}.`,
      );
    }

    const declared = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!ACCEPTED_CONTENT_TYPES.has(declared)) {
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `Send the file as its own content type: ${[...ACCEPTED_CONTENT_TYPES].join(', ')}.`,
        { contentType: declared },
      );
    }

    const body: unknown = request.body;
    if (!Buffer.isBuffer(body)) {
      // The raw parser did not run, which means the body was not one of the
      // types routed to it, or was larger than it accepts.
      throw new DomainError(
        TradingErrorCode.VALIDATION_FAILED,
        `The file was not received. It must be at most ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB and sent as the request body.`,
      );
    }

    return this.kyc.upload({
      userId: user.id,
      kind: kind.data,
      filename: filename === undefined || filename.length === 0 ? null : filename,
      bytes: body,
    });
  }

  @Post('submit')
  @RequirePermissions(Permission.KYC_SUBMIT)
  @ApiOperation({ summary: 'Hand your documents over for review' })
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<KycView> {
    return this.kyc.submit(user.id);
  }
}
