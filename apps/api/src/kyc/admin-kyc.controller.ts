import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { AdminKycService, type QueueRow, type RecordDetail } from './admin-kyc.service';
import { DecideKycDto, RevokeKycDto } from './dto/kyc.dto';

/**
 * The verification queue.
 *
 * Three capabilities across these routes, and the split is deliberate:
 * `kyc.read_any` sees statuses and the queue; `kyc.documents.read` opens the
 * documents; `kyc.review` decides. A support role holds the first and neither
 * of the others.
 */
@ApiTags('admin')
@Controller('admin/kyc')
export class AdminKycController {
  constructor(private readonly kyc: AdminKycService) {}

  @Get()
  @RequirePermissions(Permission.KYC_READ_ANY)
  @ApiOperation({ summary: 'Verifications waiting for a decision, oldest first' })
  @ApiQuery({ name: 'status', required: false, type: String })
  async queue(@Query('status') status?: string): Promise<{ records: readonly QueueRow[] }> {
    return { records: await this.kyc.queue(status === undefined ? {} : { status }) };
  }

  @Get(':id')
  @RequirePermissions(Permission.KYC_READ_ANY)
  @ApiOperation({ summary: 'One verification and the documents on it, by metadata' })
  async one(@Param('id', ParseUUIDPipe) id: string): Promise<RecordDetail> {
    return this.kyc.get(id);
  }

  /**
   * The bytes of one document, for a reviewer.
   *
   * `Content-Disposition: inline` so the browser shows it rather than saving
   * it, and `Cache-Control: no-store` so it does not stay on the reviewer's
   * disk afterwards. Every call writes an audit row before a byte is sent.
   */
  @Get(':id/documents/:documentId')
  @RequirePermissions(Permission.KYC_DOCUMENTS_READ)
  @Header('Cache-Control', 'no-store, private')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Open one identity document. Audited.' })
  async document(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const opened = await this.kyc.openDocument({ recordId: id, documentId, actorId: actor.id });
    response.setHeader('Content-Type', opened.contentType);
    response.setHeader('Content-Length', String(opened.bytes.length));
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${(opened.filename ?? documentId).replace(/["\\]/g, '')}"`,
    );
    response.end(opened.bytes);
  }

  @Post(':id/claim')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({ summary: 'Take a verification off the queue to review it' })
  async claim(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<RecordDetail> {
    return this.kyc.claim({ recordId: id, actorId: actor.id });
  }

  @Post(':id/release')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({ summary: 'Put a verification back in the queue undecided' })
  async release(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<RecordDetail> {
    return this.kyc.release({ recordId: id, actorId: actor.id });
  }

  @Post(':id/decide')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({ summary: 'Verify or reject, with a reason' })
  async decide(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DecideKycDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<RecordDetail> {
    return this.kyc.decide({
      recordId: id,
      outcome: body.outcome,
      reason: body.reason,
      actorId: actor.id,
    });
  }

  @Post(':id/revoke')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({ summary: 'Withdraw a verification already granted' })
  async revoke(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeKycDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<RecordDetail> {
    return this.kyc.revoke({ recordId: id, reason: body.reason, actorId: actor.id });
  }
}
