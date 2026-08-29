import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ReconciliationReadService } from './reconciliation.service';

const runsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
  .strict();

const findingsQuerySchema = z
  .object({
    status: z
      .enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE'])
      .optional(),
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
    accountId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const statusSchema = z
  .object({
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE']),
    note: z.string().max(1_000).optional(),
  })
  .strict();

class RunsQueryDto extends createZodDto(runsQuerySchema) {}
class FindingsQueryDto extends createZodDto(findingsQuerySchema) {}
class StatusDto extends createZodDto(statusSchema) {}

/**
 * Reconciliation, as an operator sees it.
 *
 * Nothing on this controller repairs anything. Correcting a discrepancy is a
 * ledger adjustment — a different route, a different permission, a second
 * factor and a reason — and keeping them apart is what stops "resolve" from
 * quietly meaning "make it go away".
 */
@ApiTags('reconciliation')
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationReadService) {}

  @RequirePermissions(Permission.RECONCILIATION_READ)
  @Get('runs')
  @ApiOperation({ summary: 'Recent reconciliation runs, clean ones included' })
  runs(@Query() query: RunsQueryDto) {
    return this.reconciliation.runs(query.limit);
  }

  @RequirePermissions(Permission.RECONCILIATION_READ)
  @Get('findings')
  @ApiOperation({ summary: 'Discrepancies, with how long each has been true' })
  findings(@Query() query: FindingsQueryDto) {
    return this.reconciliation.findings({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @RequirePermissions(Permission.RECONCILIATION_READ)
  @Post('findings/:id/status')
  @ApiOperation({ summary: 'Record what a person decided about a finding' })
  setStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StatusDto,
  ) {
    return this.reconciliation.setFindingStatus(actor.id, id, body.status, body.note ?? null);
  }

  @RequirePermissions(Permission.RECONCILIATION_RUN)
  @Post('runs')
  @ApiOperation({ summary: 'Ask the worker to reconcile now' })
  run(@CurrentUser() actor: AuthenticatedUser) {
    return this.reconciliation.requestRun(actor.id);
  }
}
