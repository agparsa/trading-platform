import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AdminService } from './admin.service';
import { AdjustmentsService } from './adjustments.service';
import { RiskConsoleService } from './risk-console.service';
import { AuditQueryService } from './audit-query.service';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal number');

const userSearchSchema = z
  .object({
    search: z.string().max(200).optional(),
    role: z.enum(['USER', 'SUPPORT', 'OPERATOR', 'RISK_MANAGER', 'ADMIN']).optional(),
    active: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const accountSearchSchema = z
  .object({
    search: z.string().max(200).optional(),
    status: z.enum(['ACTIVE', 'RESTRICTED', 'CLOSE_ONLY', 'SUSPENDED', 'CLOSED']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Every state change carries a reason. See AdminService. */
const reasonSchema = z.object({ reason: z.string().min(4).max(500) }).strict();

const accountStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'RESTRICTED', 'CLOSE_ONLY', 'SUSPENDED', 'CLOSED']),
    reason: z.string().min(4).max(500),
  })
  .strict();

const limitsSchema = z
  .object({
    marginCallLevelPercent: decimal.optional(),
    stopOutLevelPercent: decimal.optional(),
    maxPositionVolume: decimal.nullable().optional(),
    maxOpenPositions: z.number().int().min(1).max(10_000).nullable().optional(),
    maxGrossNotional: decimal.nullable().optional(),
    maxSymbolNetVolume: decimal.nullable().optional(),
  })
  .strict();

const adjustmentSchema = z
  .object({
    amount: decimal,
    type: z.enum(['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT', 'FEE']),
    reason: z.string().min(8).max(500),
    /** A current code from the administrator's own authenticator. */
    totpCode: z.string().min(6).max(20),
    compensatesId: z.string().uuid().nullable().optional(),
  })
  .strict();

const riskEventQuerySchema = z
  .object({
    accountId: z.string().uuid().optional(),
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
    rule: z.string().max(100).optional(),
    since: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

const atRiskQuerySchema = z
  .object({
    below: z.coerce.number().min(0).max(100_000).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const auditQuerySchema = z
  .object({
    actorId: z.string().uuid().optional(),
    action: z.string().max(100).optional(),
    resourceType: z.string().max(100).optional(),
    resourceId: z.string().max(100).optional(),
    since: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

class UserSearchDto extends createZodDto(userSearchSchema) {}
class AccountSearchDto extends createZodDto(accountSearchSchema) {}
class ReasonDto extends createZodDto(reasonSchema) {}
class AccountStatusDto extends createZodDto(accountStatusSchema) {}
class LimitsDto extends createZodDto(limitsSchema) {}
class AdjustmentDto extends createZodDto(adjustmentSchema) {}
class RiskEventQueryDto extends createZodDto(riskEventQuerySchema) {}
class AtRiskQueryDto extends createZodDto(atRiskQuerySchema) {}
class AuditQueryDto extends createZodDto(auditQuerySchema) {}

/**
 * The administrative surface.
 *
 * Grouped under one controller so that the question "what can an administrator
 * do" has one file as its answer. Every route names the permission it needs;
 * none of them defaults to a role, because a role is a set of permissions and
 * checking the set directly is how a role stops being narrowable.
 *
 * Note the split that runs through it: routes that change what an account may
 * *do* need `accounts.manage`; the single route that changes what an account is
 * *worth* needs `accounts.adjust`, which nobody holds by default and which is
 * not implied by anything else.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly adjustments: AdjustmentsService,
    private readonly risk: RiskConsoleService,
    private readonly auditQuery: AuditQueryService,
  ) {}

  // ─── People ──────────────────────────────────────────────────────────────

  @RequirePermissions(Permission.USERS_READ_ANY)
  @Get('users')
  @ApiOperation({ summary: 'Search users' })
  users(@Query() query: UserSearchDto) {
    return this.admin.findUsers({
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.active === undefined ? {} : { active: query.active === 'true' }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @RequirePermissions(Permission.USERS_READ_ANY)
  @Get('users/:id')
  @ApiOperation({ summary: 'One user, with their accounts and live sessions' })
  user(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.userDetail(id);
  }

  @RequirePermissions(Permission.USERS_MANAGE)
  @Post('users/:id/suspend')
  @ApiOperation({ summary: 'Stop a user signing in, and end their sessions' })
  suspend(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.admin.setUserActive(actor.id, id, false, body.reason);
  }

  @RequirePermissions(Permission.USERS_MANAGE)
  @Post('users/:id/reinstate')
  @ApiOperation({ summary: 'Let a suspended user sign in again' })
  reinstate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.admin.setUserActive(actor.id, id, true, body.reason);
  }

  @RequirePermissions(Permission.USERS_MANAGE)
  @Post('users/:id/sign-out')
  @ApiOperation({ summary: 'End every session a user has, without suspending them' })
  signOut(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.admin.forceSignOut(actor.id, id, body.reason);
  }

  @RequirePermissions(Permission.USERS_MANAGE)
  @Post('users/:id/unlock')
  @ApiOperation({ summary: 'Clear a lockout from failed sign-in attempts' })
  unlock(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.unlock(actor.id, id);
  }

  // ─── Accounts ────────────────────────────────────────────────────────────

  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @Get('accounts')
  @ApiOperation({ summary: 'Search accounts' })
  accounts(@Query() query: AccountSearchDto) {
    return this.admin.findAccounts({
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @RequirePermissions(Permission.ACCOUNTS_MANAGE)
  @Post('accounts/:id/status')
  @ApiOperation({ summary: 'Freeze, restrict, reinstate or close an account' })
  accountStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AccountStatusDto,
  ) {
    return this.admin.setAccountStatus(actor.id, id, body.status, body.reason);
  }

  @RequirePermissions(Permission.RISK_MANAGE)
  @Post('accounts/:id/limits')
  @ApiOperation({ summary: "Change an account's risk thresholds and limits" })
  limits(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LimitsDto,
  ) {
    return this.admin.setAccountLimits(actor.id, id, body);
  }

  /**
   * The one route in the platform that moves money by hand.
   *
   * It appends a ledger entry; nothing anywhere sets a balance. It needs
   * `accounts.adjust`, a current code from the administrator's own
   * authenticator, and a reason in words. See `AdjustmentsService` for why each
   * of the three is there.
   */
  @RequirePermissions(Permission.ACCOUNTS_ADJUST)
  @Post('accounts/:id/adjustments')
  @ApiOperation({ summary: 'Post a correcting entry to an account ledger' })
  adjust(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdjustmentDto,
    @IdempotencyKey() key: string,
  ) {
    return this.adjustments.adjust(actor.id, {
      accountId: id,
      amount: body.amount,
      type: body.type,
      reason: body.reason,
      totpCode: body.totpCode,
      idempotencyKey: key,
      compensatesId: body.compensatesId ?? null,
    });
  }

  // ─── Risk console ────────────────────────────────────────────────────────

  @RequirePermissions(Permission.RISK_READ)
  @Get('risk/at-risk')
  @ApiOperation({ summary: 'Accounts near their margin thresholds, valued live' })
  atRisk(@Query() query: AtRiskQueryDto) {
    // `below` omitted means every account with margin committed. See atRisk.
    return this.risk.atRisk({
      ...(query.below === undefined ? {} : { belowPercent: query.below }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @RequirePermissions(Permission.RISK_READ)
  @Get('risk/exposure')
  @ApiOperation({ summary: 'Open volume by instrument and side' })
  exposure() {
    return this.risk.exposure();
  }

  @RequirePermissions(Permission.RISK_READ)
  @Get('risk/events')
  @ApiOperation({ summary: 'Recorded risk decisions' })
  riskEvents(@Query() query: RiskEventQueryDto) {
    return this.risk.events({
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      ...(query.rule === undefined ? {} : { rule: query.rule }),
      ...(query.since === undefined ? {} : { sinceMs: query.since }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  // ─── Audit ───────────────────────────────────────────────────────────────

  @RequirePermissions(Permission.AUDIT_READ)
  @Get('audit')
  @ApiOperation({ summary: 'The audit trail' })
  audit(@Query() query: AuditQueryDto) {
    return this.auditQuery.search({
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
      ...(query.resourceId === undefined ? {} : { resourceId: query.resourceId }),
      ...(query.since === undefined ? {} : { sinceMs: query.since }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @RequirePermissions(Permission.AUDIT_READ)
  @Get('audit/actions')
  @ApiOperation({ summary: 'Which actions appear in the trail, and how often' })
  auditActions() {
    return this.auditQuery.actions();
  }
}
