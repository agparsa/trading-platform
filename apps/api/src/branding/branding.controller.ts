import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BRAND_NAME_MAX, Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { BrandingService } from './branding.service';

const colour = z.string().trim().toLowerCase().max(7).nullable().optional();
const updateSchema = z
  .object({
    name: z
      .string()
      .max(BRAND_NAME_MAX + 20)
      .nullable()
      .optional(),
    accentDark: colour,
    accentLight: colour,
    supportEmail: z.string().max(254).nullable().optional(),
    websiteUrl: z.string().max(500).nullable().optional(),
  })
  .strict();
class UpdateBrandingDto extends createZodDto(updateSchema) {}

/**
 * The firm's look, as the sign-in page and every screen wear it. Public: it is
 * shown before anyone signs in, and it holds nothing a visitor would not see
 * on the page anyway.
 */
@ApiTags('branding')
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: "This firm's name, accent colours and contact details" })
  current() {
    return this.branding.current();
  }
}

/** Changing it is the owner's: the same capability as the firm's other settings. */
@ApiTags('branding')
@Controller('admin/branding')
@SessionOnly()
export class AdminBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @SessionOnly()
  @RequirePermissions(Permission.TENANT_SETTINGS_MANAGE)
  @ApiOperation({ summary: "The firm's branding, for editing" })
  current() {
    return this.branding.current();
  }

  @Put()
  @SessionOnly()
  @RequirePermissions(Permission.TENANT_SETTINGS_MANAGE)
  @ApiOperation({
    summary: 'Change the branding. A field left out is unchanged; null returns it to the default.',
  })
  update(@CurrentUser() actor: AuthenticatedUser, @Body() body: UpdateBrandingDto) {
    return this.branding.update(actor.id, body);
  }
}
