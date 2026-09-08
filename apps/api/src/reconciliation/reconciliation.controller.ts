import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ReconciliationReadService } from './reconciliation.service';
import { ExternalReconciliationService } from './external-reconciliation.service';

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

const itemsQuerySchema = z
  .object({
    runId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    status: z
      .enum([
        'MATCHED',
        'MISSING_INTERNAL',
        'MISSING_EXTERNAL',
        'QUANTITY_MISMATCH',
        'PRICE_MISMATCH',
        'FEE_MISMATCH',
        'BALANCE_MISMATCH',
        'UNKNOWN',
      ])
      .optional(),
    subject: z.enum(['BALANCE', 'ORDER', 'POSITION', 'EXECUTION']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

/**
 * `since` is an ISO string, not a coerced date. `z.coerce.date()` in a DTO
 * takes the whole API down at boot: the OpenAPI document is generated from
 * these schemas and a `Date` has no JSON Schema representation. It has
 * happened twice.
 */
const externalRunSchema = z
  .object({
    connectionId: z.string().uuid(),
    since: z.string().datetime({ offset: true }).optional(),
    /**
     * Decimal strings. A tolerance is a decision a firm makes about a
     * particular venue, and it is recorded on every item it is applied to
     * rather than silently swallowing the difference.
     */
    tolerances: z
      .object({
        quantity: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        fee: z.string().regex(/^\d+(\.\d+)?$/).optional(),
        balance: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const resolutionSchema = z
  .object({
    itemId: z.string().uuid().optional(),
    findingId: z.string().uuid().optional(),
    decision: z.enum([
      'FALSE_POSITIVE',
      'ACCEPTED_DIFFERENCE',
      'CORRECTED_MANUALLY',
      'UNDER_INVESTIGATION',
      'ESCALATED',
    ]),
    /**
     * Required, and not merely non-empty by convention — the database refuses a
     * blank one too. A decision with no reason is a decision nobody can review,
     * and these are read months later by people who were not there.
     */
    note: z.string().trim().min(1).max(2_000),
  })
  .strict();

const resolutionsQuerySchema = z
  .object({
    itemId: z.string().uuid().optional(),
    findingId: z.string().uuid().optional(),
  })
  .strict();

class RunsQueryDto extends createZodDto(runsQuerySchema) {}
class ItemsQueryDto extends createZodDto(itemsQuerySchema) {}
class ExternalRunDto extends createZodDto(externalRunSchema) {}
class ResolutionDto extends createZodDto(resolutionSchema) {}
class ResolutionsQueryDto extends createZodDto(resolutionsQuerySchema) {}
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
  constructor(
    private readonly reconciliation: ReconciliationReadService,
    private readonly external: ExternalReconciliationService,
  ) {}

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

  /**
   * Recording a decision is a write, so it takes a write permission.
   *
   * This route used to require `RECONCILIATION_READ`, which meant anyone who
   * could see a discrepancy could also declare it resolved. `OPERATOR` holds
   * read and no longer holds this: an operator can see a finding and escalate
   * it, and deciding that a money discrepancy is a false positive is a
   * judgement that belongs with risk management.
   */
  @RequirePermissions(Permission.RECONCILIATION_MANAGE)
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

  // ---- External (§44) ------------------------------------------------------

  /**
   * What a run found when it compared this platform against a venue.
   *
   * Only disagreements are rows — a matched order is a row the platform would
   * write on every run for the life of the account, and the run's counts say
   * what those rows would have said.
   */
  @RequirePermissions(Permission.RECONCILIATION_READ)
  @Get('items')
  @ApiOperation({ summary: 'Where this platform and a venue disagree' })
  items(@Query() query: ItemsQueryDto) {
    return this.reconciliation.items({
      ...(query.runId === undefined ? {} : { runId: query.runId }),
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.subject === undefined ? {} : { subject: query.subject }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  /**
   * Compare against a venue, now.
   *
   * Synchronous rather than queued, unlike the internal run: this one talks to
   * a venue over the network and the person who asked needs to be told whether
   * it could be reached. A queued job that silently counted an unreachable
   * venue as a clean pass is the failure this whole feature exists to avoid.
   */
  @RequirePermissions(Permission.RECONCILIATION_RUN)
  @Post('external-runs')
  @ApiOperation({ summary: 'Compare this platform against a venue now' })
  runExternal(@CurrentUser() actor: AuthenticatedUser, @Body() body: ExternalRunDto) {
    return this.external.run({
      connectionId: body.connectionId,
      trigger: 'MANUAL',
      requestedByUserId: actor.id,
      ...(body.since === undefined ? {} : { since: new Date(body.since) }),
      ...(body.tolerances === undefined ? {} : { tolerances: body.tolerances }),
    });
  }

  /**
   * Record what a person decided about a discrepancy.
   *
   * `RECONCILIATION_MANAGE`, like closing a finding, and for the same reason:
   * anyone who can see a discrepancy must not thereby be able to declare it
   * accounted for. Nothing here repairs anything — the decision is recorded
   * beside the observation, and the observation is left exactly as the machine
   * made it.
   */
  @RequirePermissions(Permission.RECONCILIATION_MANAGE)
  @Post('resolutions')
  @ApiOperation({ summary: 'Record a decision about a discrepancy, with its reason' })
  resolve(@CurrentUser() actor: AuthenticatedUser, @Body() body: ResolutionDto) {
    return this.external.resolve({
      userId: actor.id,
      ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
      ...(body.findingId === undefined ? {} : { findingId: body.findingId }),
      decision: body.decision,
      note: body.note,
    });
  }

  /** Every decision recorded about one discrepancy, oldest first. */
  @RequirePermissions(Permission.RECONCILIATION_READ)
  @Get('resolutions')
  @ApiOperation({ summary: 'The decisions recorded about a discrepancy' })
  resolutions(@Query() query: ResolutionsQueryDto) {
    return this.reconciliation.resolutions({
      ...(query.itemId === undefined ? {} : { itemId: query.itemId }),
      ...(query.findingId === undefined ? {} : { findingId: query.findingId }),
    });
  }
}
