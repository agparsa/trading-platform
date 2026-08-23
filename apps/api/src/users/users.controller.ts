import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';

const updateProfileSchema = z.object({ displayName: z.string().trim().min(1).max(120) }).strict();
class UpdateProfileDto extends createZodDto(updateProfileSchema) {}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'The authenticated user’s profile' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.profile(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update your display name' })
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateProfileDto) {
    return this.users.updateDisplayName(user.id, body.displayName);
  }

  @Get('me/sessions')
  @ApiOperation({ summary: 'Your active sessions' })
  sessions(@CurrentUser() user: AuthenticatedUser) {
    return this.users.sessions(user.id);
  }
}
