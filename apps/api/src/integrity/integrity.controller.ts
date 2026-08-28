import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { IntegrityService } from './integrity.service';

const listQuerySchema = z
  .object({
    status: z
      .enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE'])
      .optional(),
    accountId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/**
 * `FALSE_POSITIVE` is in this list for the same reason it is in the enum: the
 * engine is expected to be wrong sometimes, and an operator needs a way to say
 * so that is not "resolved". Without it, every dismissal looks like a handled
 * incident and nobody can tell how noisy a detector actually is.
 */
const setStatusSchema = z
  .object({
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE']),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

class ListQueryDto extends createZodDto(listQuerySchema) {}
class SetStatusDto extends createZodDto(setStatusSchema) {}

@ApiTags('integrity')
@Controller('integrity')
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  @RequirePermissions(Permission.INTEGRITY_READ)
  @Get('signals')
  @ApiOperation({ summary: 'Integrity signals, most recently seen first' })
  list(@Query() query: ListQueryDto) {
    return this.integrity.list(query);
  }

  @RequirePermissions(Permission.INTEGRITY_READ)
  @Get('signals/:id')
  @ApiOperation({ summary: 'One signal with its whole history' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.integrity.detail(id);
  }

  @RequirePermissions(Permission.INTEGRITY_MANAGE)
  @Post('signals/:id/status')
  @ApiOperation({ summary: 'Move a signal through review' })
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetStatusDto,
  ) {
    return this.integrity.setStatus(user.id, id, body.status, body.note);
  }

  /**
   * Observe one account now.
   *
   * On demand as well as scheduled, because the moment an operator most wants a
   * scan is the moment they are already looking at an account — and telling them
   * to wait for the next sweep is telling them to lose the thread.
   */
  @RequirePermissions(Permission.INTEGRITY_MANAGE)
  @Post('scan/:accountId')
  @ApiOperation({ summary: 'Observe one account now' })
  async scan(@Param('accountId', ParseUUIDPipe) accountId: string) {
    const signals = await this.integrity.scanAccount(accountId);
    return { accountId, raised: signals.length, signals };
  }
}
