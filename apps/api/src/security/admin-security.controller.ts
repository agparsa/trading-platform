import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  SecurityEventsService,
  type AdminSecurityEventView,
  type SecurityFeedSummary,
} from './security-events.service';

const KINDS = [
  'SIGN_IN',
  'SIGN_IN_FAILED',
  'SECOND_FACTOR_FAILED',
  'SIGN_IN_NEW_DEVICE',
  'SIGN_OUT',
  'SESSION_REVOKED',
  'SESSIONS_REVOKED_BY_STAFF',
  'EMAIL_VERIFIED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'TWO_FACTOR_ENABLED',
  'TWO_FACTOR_DISABLED',
  'RECOVERY_CODE_USED',
  'API_KEY_MINTED',
  'API_KEY_REVOKED',
  'SERVICE_TOKEN_MINTED',
  'SERVICE_TOKEN_REVOKED',
  'ROLE_ASSIGNED',
  'USER_SUSPENDED',
  'USER_REINSTATED',
  'USER_UNLOCKED',
] as const;

const feedSchema = z
  .object({
    userId: z.string().uuid().optional(),
    kind: z.enum(KINDS).optional(),
    severity: z.enum(['INFO', 'NOTICE', 'WARNING']).optional(),
    /** ISO-8601. A string here rather than a date: the OpenAPI document cannot describe a Date. */
    since: z.string().datetime({ offset: true }).optional(),
    ipAddress: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

class FeedQueryDto extends createZodDto(feedSchema) {}

/** The firm's feed, for support, risk and administration. */
@ApiTags('admin-security')
@Controller('admin/security')
export class AdminSecurityController {
  constructor(private readonly events: SecurityEventsService) {}

  @RequirePermissions(Permission.SECURITY_READ)
  @Get('events')
  @ApiOperation({ summary: "Everyone's security events, filtered and newest first" })
  async feed(@Query() query: FeedQueryDto): Promise<{ events: readonly AdminSecurityEventView[] }> {
    return {
      events: await this.events.listAll({
        ...query,
        since: query.since === undefined ? undefined : new Date(query.since),
      }),
    };
  }

  @RequirePermissions(Permission.SECURITY_READ)
  @Get('summary')
  @ApiOperation({ summary: 'Counts by kind and severity over the last day' })
  summary(@Query('since') since?: string): Promise<SecurityFeedSummary> {
    const parsed = since === undefined ? Number.NaN : Date.parse(since);
    return this.events.summary(
      Number.isFinite(parsed) ? new Date(parsed) : new Date(Date.now() - 86_400_000),
    );
  }
}
