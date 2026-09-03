import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { SecurityEventsService, type SecurityEventView } from './security-events.service';

const mineSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    /** ISO-8601; the OpenAPI document cannot describe a Date. */
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

class MineQueryDto extends createZodDto(mineSchema) {}

/**
 * A person's own security feed. Self-service: the subject is the caller, and
 * a credential minted by them may not read it — the feed is where a stolen
 * key's use would show up, and the key must not be able to watch for that.
 */
@ApiTags('security')
@Controller('security')
export class SecurityController {
  constructor(private readonly events: SecurityEventsService) {}

  @SelfService()
  @Get('events')
  @ApiOperation({ summary: 'What has happened to your account: sign-ins, keys, changes' })
  async mine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MineQueryDto,
  ): Promise<{ events: readonly SecurityEventView[] }> {
    return {
      events: await this.events.listMine(user.id, {
        limit: query.limit,
        before: query.before === undefined ? undefined : new Date(query.before),
      }),
    };
  }
}
