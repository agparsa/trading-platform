import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { UsersService } from './users.service';

/**
 * E.164: a plus, a country code that does not start with 0, and at most fifteen
 * digits in all. Spaces, dashes and brackets a person types are removed first,
 * so "+98 912 123 4567" is accepted and stored as "+989121234567".
 */
export const E164 = /^\+[1-9]\d{6,14}$/;

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    // The description does more than describe. Without a keyword on the
    // string, Zod writes `string | null` as `type: ['string', 'null']`, and
    // @nestjs/swagger reads a list of types as "an array of the first one": the
    // published schema said `phone` was an array of strings, and
    // `pnpm smoke:contracts` failed the web's PATCH for sending a string or
    // null. With it, Zod writes `anyOf: [string, null]`, which survives.
    phone: z
      .string()
      .describe('A phone number in international form, such as +989121234567, or null to remove it')
      .transform((value) => value.replace(/[\s()-]/g, ''))
      .refine((value) => E164.test(value), {
        message: 'A phone number in international form, such as +989121234567',
      })
      .nullable()
      .optional(),
  })
  .strict()
  .refine((body) => body.displayName !== undefined || body.phone !== undefined, {
    message: 'Nothing to change',
  });
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
  @ApiOperation({ summary: 'Update your display name and contact number' })
  update(@CurrentUser() user: AuthenticatedUser, @Body() body: UpdateProfileDto) {
    return this.users.updateProfile(user.id, {
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.phone === undefined ? {} : { phone: body.phone }),
    });
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
