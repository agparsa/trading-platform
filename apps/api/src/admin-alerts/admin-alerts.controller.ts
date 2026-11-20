import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ADMIN_ALERT_METRICS, Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { AdminAlertRulesService } from './admin-alerts.service';

const ruleSchema = z
  .object({
    name: z.string().max(120),
    metric: z.string().max(64),
    comparator: z.enum(['ABOVE', 'BELOW']),
    threshold: z.number().int(),
    cooldownMinutes: z.number().int(),
    enabled: z.boolean(),
  })
  .strict();
class AlertRuleDto extends createZodDto(ruleSchema) {}

const ackSchema = z.object({ note: z.string().trim().max(500).nullable().optional() }).strict();
class AcknowledgeAlertDto extends createZodDto(ackSchema) {}

/**
 * Admin alerts (§ broker panel): thresholds operations set on counts the
 * platform keeps, and the alerts the worker raises when one is crossed.
 * Operations' business throughout — the same capability as the rest of the
 * operational console.
 */
@ApiTags('admin-alerts')
@Controller('admin/alerts')
@SessionOnly()
export class AdminAlertsController {
  constructor(private readonly alerts: AdminAlertRulesService) {}

  @Get('metrics')
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'What an alert rule can watch' })
  metrics() {
    return { metrics: ADMIN_ALERT_METRICS };
  }

  @Get('rules')
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Every alert rule, with its last reading' })
  async rules() {
    return { rules: await this.alerts.rules() };
  }

  @Post('rules')
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Create an alert rule' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() body: AlertRuleDto) {
    return this.alerts.save(actor.id, body);
  }

  @Put('rules/:id')
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Change an alert rule' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AlertRuleDto,
  ) {
    return this.alerts.save(actor.id, body, id);
  }

  @Delete('rules/:id')
  @SessionOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Delete an alert rule and the alerts it raised' })
  async remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.alerts.remove(actor.id, id);
  }

  @Get()
  @ApiQuery({ name: 'state', required: false, enum: ['open', 'all'], description: 'default open' })
  @ApiQuery({ name: 'limit', required: false, type: String, description: '1–200, default 100' })
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Raised alerts, unacknowledged or all, newest first' })
  list(@Query('state') state?: string, @Query('limit') limit?: string) {
    return this.alerts.alerts(state === 'all' ? 'all' : 'open', Number(limit ?? 100) || 100);
  }

  @Post(':id/acknowledge')
  @SessionOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Acknowledge an alert, with an optional note' })
  async acknowledge(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AcknowledgeAlertDto,
  ) {
    const note = body.note?.trim();
    await this.alerts.acknowledge(actor.id, id, note === undefined || note === '' ? null : note);
  }
}
