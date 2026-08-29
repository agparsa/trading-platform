import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
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

  @SelfService()
  @Patch('me')
  @ApiOperation({ summary: 'Update your display name' })
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateProfileDto) {
    return this.users.updateDisplayName(user.id, body.displayName);
  }

  /*
   * `GET /users/me/sessions` used to live here. It listed refresh-token rows —
   * about ninety-six a day from one browser — with no way to end any of them,
   * and it returned the raw user agent for the reader to interpret.
   *
   * `GET /auth/sessions` replaced it: one entry per sign-in, described in words,
   * with the caller's own marked and a DELETE beside it. Two answers to "where
   * am I signed in" is one too many, so this one is gone rather than left to
   * drift out of agreement with the other. See docs/sessions.md.
   */
}
