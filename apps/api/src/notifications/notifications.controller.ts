import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { NotificationCategory } from '@tp/shared-types';
import { NotificationsService } from './notifications.service';
import { PreferencesService } from './preferences.service';

const listQuerySchema = z
  .object({
    unread: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

class ListQueryDto extends createZodDto(listQuerySchema) {}

const settingsSchema = z
  .object({
    tradingEnabled: z.boolean().optional(),
    pushEnabled: z.boolean().optional(),
    soundEnabled: z.boolean().optional(),
    vibrationEnabled: z.boolean().optional(),
    soundVolume: z.number().int().min(0).max(100).optional(),
    // Minutes from midnight. 0 is a legitimate value (midnight), so the bound
    // is inclusive at the bottom and exclusive at 1440.
    quietHoursStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
    quietHoursEndMinute: z.number().int().min(0).max(1439).nullable().optional(),
    quietHoursTimezone: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

class SettingsDto extends createZodDto(settingsSchema) {}

const categorySchema = z
  .object({
    inApp: z.boolean().optional(),
    push: z.boolean().optional(),
    sound: z.boolean().optional(),
    email: z.boolean().optional(),
  })
  .strict();

class CategoryDto extends createZodDto(categorySchema) {}

const CATEGORY_VALUES = Object.values(NotificationCategory) as [string, ...string[]];

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
  constructor(
    private readonly notifications: NotificationsService,
    private readonly preferences: PreferencesService,
  ) {}

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

  @Get('preferences')
  @ApiOperation({ summary: 'What this user wants to be told, and how' })
  preferencesFor(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.get(user.id);
  }

  @SelfService()
  @Patch('preferences')
  @ApiOperation({ summary: 'Change the switches that apply to every category' })
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Body() body: SettingsDto) {
    return this.preferences.updateSettings(user.id, body);
  }

  /**
   * Change one category.
   *
   * Returns 400 for a security or risk category rather than accepting the
   * change and ignoring it — see PreferencesService for why that distinction is
   * the whole point of the endpoint.
   */
  @SelfService()
  @Patch('preferences/:category')
  @ApiOperation({ summary: 'Change one category' })
  updateCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('category') category: string,
    @Body() body: CategoryDto,
  ) {
    const parsed = z.enum(CATEGORY_VALUES).parse(category) as NotificationCategory;
    return this.preferences.updateCategory(user.id, parsed, body);
  }
}
