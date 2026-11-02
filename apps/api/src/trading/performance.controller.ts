import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import {
  CurrentUser,
  subjectOf,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PERFORMANCE_PERIODS, PerformanceService } from './performance.service';

const performanceQuerySchema = z
  .object({ period: z.enum(PERFORMANCE_PERIODS).default('3M') })
  .strict();
class PerformanceQueryDto extends createZodDto(performanceQuerySchema) {}

@ApiTags('trading')
@Controller()
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @RequirePermissions(Permission.POSITIONS_READ)
  @Get('accounts/:id/performance')
  @ApiOperation({ summary: "An account's trading performance from its closed trades" })
  forAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PerformanceQueryDto,
  ) {
    return this.performance.forAccount(subjectOf(user), id, query.period);
  }
}
