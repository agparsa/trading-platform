import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { NotificationsService } from './notifications.service';

const listQuerySchema = z
  .object({
    unread: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

class ListQueryDto extends createZodDto(listQuerySchema) {}

/**
 * A person's own notices.
 *
 * Every route is scoped to the caller in its query, not by a permission: there
 * is no notion of reading somebody else's notifications, so there is no
 * permission that could grant it and no code path that could be talked into it.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Notices for the signed-in user' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListQueryDto) {
    return this.notifications.list(user.id, {
      unreadOnly: query.unread === 'true',
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many are unread' })
  async unread(@CurrentUser() user: AuthenticatedUser) {
    return { unread: await this.notifications.unreadCount(user.id) };
  }

  @SelfService()
  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one as read' })
  read(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @SelfService()
  @Post('read-all')
  @ApiOperation({ summary: 'Mark everything as read' })
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }
}
