import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission, UserRole } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AdminService } from './admin.service';
import { AdjustmentsService } from './adjustments.service';
import { RiskHierarchyService, type LimitSetView } from './risk-hierarchy.service';
import {
  BlotterService,
  type OrderRow,
  type Page,
  type PositionRow,
  type TradeRow,
  type BlotterQuery,
} from './blotter.service';
import { RiskConsoleService } from './risk-console.service';
import { AuditQueryService } from './audit-query.service';
import type { SessionView } from './instruments.service';
import { AdminInstrumentsService } from './instruments.service';
import { InvitesService } from '../auth/invites.service';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal number');
/** Terms are quantities, never negative: a negative margin rate is not a discount. */
const positiveDecimal = z.string().regex(/^\d+(\.\d+)?$/, 'Must be a non-negative decimal');

const instrumentEnabledSchema = z
  .object({ enabled: z.boolean(), reason: z.string().trim().min(8).max(500) })
  .strict();

const instrumentTermsSchema = z
  .object({
    marginRate: positiveDecimal.optional(),
    commissionPerLot: positiveDecimal.optional(),
    swapLongPerLot: decimal.optional(),
    swapShortPerLot: decimal.optional(),
    maxVolume: positiveDecimal.optional(),
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

class InstrumentEnabledDto extends createZodDto(instrumentEnabledSchema) {}
class InstrumentTermsDto extends createZodDto(instrumentTermsSchema) {}

const mintInviteSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    maxUses: z.coerce.number().int().min(1).max(1_000).optional(),
    ttlHours: z.coerce.number().int().min(1).max(8_760).optional(),
    /** The role the redeemer receives instead of USER. Bounded by the minter's own. */
    grantsRole: z.nativeEnum(UserRole).optional(),
  })
  .strict();

class MintInviteDto extends createZodDto(mintInviteSchema) {}

const userSearchSchema = z
  .object({
    search: z.string().max(200).optional(),
    role: z.nativeEnum(UserRole).optional(),
    active: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

const accountSearchSchema = z
  .object({
    search: z.string().max(200).optional(),
    status: z
      .enum(['PENDING', 'ACTIVE', 'RESTRICTED', 'CLOSE_ONLY', 'LOCKED', 'SUSPENDED', 'CLOSED'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/** Every state change carries a reason. See AdminService. */
const reasonSchema = z.object({ reason: z.string().min(4).max(500) }).strict();

const accountStatusSchema = z
  .object({
    status: z.enum([
      'PENDING',
      'ACTIVE',
      'RESTRICTED',
      'CLOSE_ONLY',
      'LOCKED',
      'SUSPENDED',
      'CLOSED',
    ]),
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

/**
 * A layer's ceiling. The margin-call and stop-out levels are deliberately not
 * here: they are not caps, "stricter" runs the other way for them, and a
 * hierarchy that minimised them would give every account the loosest stop-out
 * on the platform. They stay account-only until they have their own direction.
 */
const riskLimitsSchema = z
  .object({
    maxPositionVolume: decimal.nullable().optional(),
    maxOpenPositions: z.number().int().min(1).max(10_000).nullable().optional(),
    maxGrossNotional: decimal.nullable().optional(),
    maxSymbolNetVolume: decimal.nullable().optional(),
  })
  .strict();

/**
 * Query strings arrive as strings. Parsed at the boundary and never coerced by
 * Zod itself: `z.coerce` in a DTO breaks the OpenAPI document and, with it,
 * the API's boot — caught once by `pnpm smoke` and not by any test.
 */
const blotterQuerySchema = z
  .object({
    accountId: z.string().uuid().optional(),
    accountNumber: z.string().trim().min(1).max(32).optional(),
    symbol: z.string().trim().min(1).max(32).optional(),
    side: z.enum(['BUY', 'SELL']).optional(),
    status: z.string().trim().min(1).max(32).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    limit: z.string().regex(/^\d{1,4}$/).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

const sessionsSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64),
    windows: z
      .array(
        z
          .object({
            dayOfWeek: z.number().int().min(0).max(6),
            openMinute: z.number().int().min(0).max(1440),
            closeMinute: z.number().int().min(0).max(1440),
          })
          .strict(),
      )
      .max(50),
    reason: z.string().min(8).max(500),
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
const assignRoleSchema = z
  .object({
    role: z.nativeEnum(UserRole),
    reason: z.string().trim().min(4).max(500),
  })
  .strict();

class ReasonDto extends createZodDto(reasonSchema) {}
class AssignRoleDto extends createZodDto(assignRoleSchema) {}
class AccountStatusDto extends createZodDto(accountStatusSchema) {}
class LimitsDto extends createZodDto(limitsSchema) {}
class RiskLimitsDto extends createZodDto(riskLimitsSchema) {}
class BlotterQueryDto extends createZodDto(blotterQuerySchema) {}
class SessionsDto extends createZodDto(sessionsSchema) {}
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
    private readonly instruments: AdminInstrumentsService,
    private readonly hierarchy: RiskHierarchyService,
    private readonly blotter: BlotterService,
    // Provided by AuthModule, which AdminModule imports. A service that is not
    // reachable from this module's imports crashes the container at boot, not
    // at the first request — which is why `pnpm smoke` and not `pnpm verify`
    // is what proves this file is wired.
    private readonly invites: InvitesService,
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

  @RequirePermissions(Permission.ROLES_ASSIGN)
  @Post('users/:id/role')
  @ApiOperation({ summary: 'Put a person into a role. Ends their sessions.' })
  assignRole(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AssignRoleDto,
    @IdempotencyKey() _idempotencyKey: string,
  ) {
    return this.admin.assignRole({
      actorId: actor.id,
      actorRole: actor.role,
      userId: id,
      role: body.role,
      reason: body.reason,
    });
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

  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @Get('accounts/:id')
  @ApiOperation({ summary: 'One account, by id' })
  account(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.accountDetail(id);
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

  // ---- The firm's book ----------------------------------------------------

  /**
   * `ACCOUNTS_READ_ANY`, not `ORDERS_READ`.
   *
   * Every trader holds `ORDERS_READ` — it is what lets them see their own
   * orders. These read across every account in the firm, so they take the
   * permission that means exactly that. The same mistake on the
   * venue-recovery console showed one trader everybody's order ids, and was
   * caught by the pentest rather than by the suite.
   */
  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @Get('orders')
  @ApiOperation({ summary: 'Every order in the firm, newest first' })
  blotterOrders(@Query() query: BlotterQueryDto): Promise<Page<OrderRow>> {
    return this.blotter.orders(toBlotterQuery(query));
  }

  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @Get('positions')
  @ApiOperation({ summary: 'Positions across the firm. Open unless a status is named.' })
  blotterPositions(@Query() query: BlotterQueryDto): Promise<Page<PositionRow>> {
    return this.blotter.positions(toBlotterQuery(query));
  }

  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @Get('trades')
  @ApiOperation({ summary: 'Closed round trips across the firm, with what each one cost' })
  blotterTrades(@Query() query: BlotterQueryDto): Promise<Page<TradeRow>> {
    return this.blotter.trades(toBlotterQuery(query));
  }

  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @Get('orders/:id/history')
  @ApiOperation({
    summary: 'Everything that happened to one order — the answer to "why was that rejected"',
  })
  orderHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.blotter.orderHistory(id);
  }

  // ---- The risk hierarchy: platform → broker → desk → account -------------

  @RequirePermissions(Permission.RISK_READ)
  @Get('risk/limits')
  @ApiOperation({
    summary: 'The ceilings above an account: the platform layer, this firm’s, and each desk’s',
  })
  riskLimits(): Promise<readonly LimitSetView[]> {
    return this.hierarchy.list();
  }

  @RequirePermissions(Permission.RISK_MANAGE)
  @Post('risk/limits/broker')
  @ApiOperation({
    summary: 'Set this firm’s ceiling. May tighten the platform’s, never loosen it.',
  })
  setBrokerLimits(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: RiskLimitsDto,
  ): Promise<LimitSetView> {
    return this.hierarchy.setBroker(actor.id, body);
  }

  @RequirePermissions(Permission.RISK_MANAGE)
  @Post('risk/limits/desk/:masterAccountId')
  @ApiOperation({
    summary: 'Set one desk’s ceiling. Binds orders its operators place, not the account owner.',
  })
  setDeskLimits(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('masterAccountId', ParseUUIDPipe) masterAccountId: string,
    @Body() body: RiskLimitsDto,
  ): Promise<LimitSetView> {
    return this.hierarchy.setDesk(actor.id, masterAccountId, body);
  }

  /**
   * The platform's own ceiling. Refused from a broker, whatever they hold:
   * `risk.manage` is authority over your own firm, not over everyone's.
   */
  @RequirePermissions(Permission.RISK_MANAGE)
  @Post('risk/limits/platform')
  @ApiOperation({ summary: 'Set the ceiling every firm trades under. Platform tenant only.' })
  setPlatformLimits(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: RiskLimitsDto,
  ): Promise<LimitSetView> {
    return this.hierarchy.setPlatform(actor.id, body);
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
  // ─── Instruments ─────────────────────────────────────────────────────────

  @RequirePermissions(Permission.INSTRUMENTS_READ)
  @Get('instruments')
  @ApiOperation({ summary: 'What the platform trades, and on what terms' })
  listInstruments() {
    return this.instruments.list();
  }

  /**
   * Suspending an instrument stops new orders and closes nothing.
   *
   * Liquidating open positions because an administrator suspended an instrument
   * would turn an operational decision into a market one taken on the trader's
   * behalf. The reply reports what is left open, so whoever pressed the button
   * can see it and decide.
   */
  @RequirePermissions(Permission.INSTRUMENTS_MANAGE)
  @Post('instruments/:code/enabled')
  @ApiOperation({ summary: 'Suspend or resume trading in one instrument' })
  setInstrumentEnabled(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('code') code: string,
    @Body() body: InstrumentEnabledDto,
  ) {
    return this.instruments.setEnabled(actor.id, code.toUpperCase(), body.enabled, body.reason);
  }

  /**
   * Margin, commission, swap and the largest order accepted.
   *
   * Not tick size, contract size or precision: those describe the instrument
   * rather than the firm's terms, and changing one under open positions
   * re-values every trade ever made in it.
   */
  @RequirePermissions(Permission.INSTRUMENTS_MANAGE)
  @Post('instruments/:code/terms')
  @ApiOperation({ summary: "Change an instrument's margin, commission, swap or size cap" })
  setInstrumentTerms(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('code') code: string,
    @Body() body: InstrumentTermsDto,
  ) {
    const { reason, ...terms } = body;
    return this.instruments.setTerms(actor.id, code.toUpperCase(), terms, reason);
  }

  @RequirePermissions(Permission.INSTRUMENTS_READ)
  @Get('instruments/:code/sessions')
  @ApiOperation({ summary: 'The week an instrument trades, in its own timezone' })
  instrumentSessions(@Param('code') code: string): Promise<SessionView> {
    return this.instruments.sessions(code);
  }

  /**
   * Replace the whole trading week.
   *
   * Wholesale rather than window by window: a half-saved week is a market that
   * is open when it should be shut. Sessions are when the *venue* trades, so
   * this is a platform act and is refused from a broker — a firm that wants an
   * instrument shut disables it for itself.
   */
  @RequirePermissions(Permission.INSTRUMENTS_MANAGE)
  @Post('instruments/:code/sessions')
  @ApiOperation({ summary: "Replace an instrument's trading week. Platform only." })
  setInstrumentSessions(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('code') code: string,
    @Body() body: SessionsDto,
  ): Promise<SessionView> {
    const { reason, ...rest } = body;
    return this.instruments.setSessions(actor.id, code.toUpperCase(), rest, reason);
  }

  /**
   * Mint an invitation. The response carries the code, once.
   *
   * There is no route that returns it again, because the platform does not have
   * it: only a SHA-256 and the first eight characters are stored. An
   * administrator who loses a code mints another and revokes the first.
   */
  @RequirePermissions(Permission.INVITES_MANAGE)
  @Post('invites')
  @ApiOperation({ summary: 'Create an invitation; the code is shown once and never again' })
  mintInvite(@CurrentUser() actor: AuthenticatedUser, @Body() body: MintInviteDto) {
    return this.invites.mint({ id: actor.id, role: actor.role }, body);
  }

  /** Invitations, by fingerprint. The codes themselves are not stored. */
  @RequirePermissions(Permission.INVITES_MANAGE)
  @Get('invites')
  @ApiOperation({ summary: 'Invitations, identified by fingerprint' })
  listInvites() {
    return this.invites.list();
  }

  @RequirePermissions(Permission.INVITES_MANAGE)
  @Post('invites/:id/revoke')
  @ApiOperation({ summary: 'Stop an invitation being redeemed again' })
  async revokeInvite(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.invites.revoke(actor.id, id);
    return { status: 'revoked' };
  }
}

/** The query string as the service wants it: dates as instants, limit as a number. */
function toBlotterQuery(query: {
  accountId?: string;
  accountNumber?: string;
  symbol?: string;
  side?: 'BUY' | 'SELL';
  status?: string;
  since?: string;
  until?: string;
  limit?: string;
  cursor?: string;
}): BlotterQuery {
  return {
    ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
    ...(query.accountNumber === undefined ? {} : { accountNumber: query.accountNumber }),
    ...(query.symbol === undefined ? {} : { symbol: query.symbol }),
    ...(query.side === undefined ? {} : { side: query.side }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.since === undefined ? {} : { sinceMs: new Date(query.since).getTime() }),
    ...(query.until === undefined ? {} : { untilMs: new Date(query.until).getTime() }),
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
}
