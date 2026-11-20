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
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { FeesService } from './fees.service';

const rate = z.string().trim().max(40);
const scheduleSchema = z
  .object({
    name: z.string().max(100),
    note: z.string().max(500).nullable().optional(),
    defaultCommissionPerLot: rate.nullable().optional(),
    rules: z
      .array(
        z.object({ symbol: z.string().trim().min(1).max(32), commissionPerLot: rate }).strict(),
      )
      .max(1000),
  })
  .strict();
class FeeScheduleDto extends createZodDto(scheduleSchema) {}

const assignSchema = z
  .object({
    scheduleId: z.string().uuid().nullable(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
class AssignFeeScheduleDto extends createZodDto(assignSchema) {}

/**
 * Fees: the commission schedules accounts can be put on, and what fees came
 * to. Schedules are instrument terms, so they sit with the instruments'
 * capabilities; putting an account on one is a change to that account.
 */
@ApiTags('fees')
@Controller('admin/fees')
@SessionOnly()
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Get('schedules')
  @SessionOnly()
  @RequirePermissions(Permission.INSTRUMENTS_READ)
  @ApiOperation({ summary: 'Every commission schedule, its rates and how many accounts pay it' })
  async list() {
    return { schedules: await this.fees.list() };
  }

  @Post('schedules')
  @SessionOnly()
  @RequirePermissions(Permission.INSTRUMENTS_MANAGE)
  @ApiOperation({ summary: 'Create a commission schedule' })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() body: FeeScheduleDto) {
    return this.fees.save(actor.id, body);
  }

  @Put('schedules/:id')
  @SessionOnly()
  @RequirePermissions(Permission.INSTRUMENTS_MANAGE)
  @ApiOperation({
    summary: 'Replace a schedule. Accounts on it pay the new rates from their next order.',
  })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FeeScheduleDto,
  ) {
    return this.fees.save(actor.id, body, id);
  }

  @Delete('schedules/:id')
  @SessionOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(Permission.INSTRUMENTS_MANAGE)
  @ApiOperation({ summary: 'Delete a schedule no account pays' })
  async remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.fees.remove(actor.id, id);
  }

  @Post('accounts/:accountId')
  @SessionOnly()
  @RequirePermissions(Permission.ACCOUNTS_MANAGE)
  @ApiOperation({
    summary: 'Put an account on a commission schedule, or back on the standard terms (null)',
  })
  assign(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() body: AssignFeeScheduleDto,
  ) {
    return this.fees.assign(actor.id, accountId, body.scheduleId, body.reason);
  }

  @Get('report')
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'ISO time; default 30 days before `to`',
  })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO time; default now' })
  @SessionOnly()
  @RequirePermissions(Permission.ACCOUNTS_READ_ANY)
  @ApiOperation({
    summary: 'Commission and swap over a period, by currency, instrument and account',
  })
  report(@Query('from') from?: string, @Query('to') to?: string) {
    const end = to === undefined ? new Date() : new Date(to);
    const start = from === undefined ? new Date(end.getTime() - 30 * 86_400_000) : new Date(from);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new DomainError(TradingErrorCode.VALIDATION_FAILED, 'from and to must be ISO dates.');
    }
    return this.fees.report(start, end);
  }
}
