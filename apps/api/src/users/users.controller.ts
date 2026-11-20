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

/** The number as stored: without the spaces, dashes and brackets people type. */
export function normalisePhone(value: string): string {
  return value.replace(/[\s()-]/g, '');
}

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    /**
     * Checked here and normalised in the handler (`normalisePhone`), not with
     * a `.transform`: a transformed string is published in the OpenAPI schema
     * as something other than a string, and the request-contract check then
     * read the web's `phone: string | null` as a mismatch.
     */
    phone: z
      .string()
      .max(40)
      .refine((value) => E164.test(normalisePhone(value)), {
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
      ...(body.phone === undefined
        ? {}
        : { phone: body.phone === null ? null : normalisePhone(body.phone) }),
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
