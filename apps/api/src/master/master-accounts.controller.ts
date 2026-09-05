import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { MasterAccountsService } from './master-accounts.service';
import { DeskViewService, type DeskView } from './desk-view.service';

const createMasterSchema = z
  .object({
    operatorUserId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

/**
 * Capabilities arrive as the catalogue's own `resource.verb` strings.
 *
 * Validated for shape here and against the linkable ceiling in the service —
 * the shape check is a courtesy to the caller, the ceiling is the rule, and the
 * rule does not live in a DTO where a second endpoint could miss it.
 */
const grantLinkSchema = z
  .object({
    accountId: z.string().uuid(),
    capabilities: z.array(z.string().trim().min(1).max(64)).min(1).max(32).optional(),
    /**
     * A preset name instead of a list. Expanded once, at grant, into the
     * capabilities actually stored — so widening a preset later cannot widen
     * a delegation someone already approved.
     */
    role: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine((body) => (body.capabilities === undefined) !== (body.role === undefined), {
    message: 'Give exactly one of `role` or `capabilities`.',
  });

class CreateMasterDto extends createZodDto(createMasterSchema) {}
class GrantLinkDto extends createZodDto(grantLinkSchema) {}

@ApiTags('master-accounts')
@Controller('master-accounts')
export class MasterAccountsController {
  constructor(
    private readonly masters: MasterAccountsService,
    private readonly desks: DeskViewService,
  ) {}

  @RequirePermissions(Permission.MASTER_READ)
  @Get()
  @ApiOperation({ summary: 'Master accounts' })
  list() {
    return this.masters.list();
  }

  @RequirePermissions(Permission.MASTER_READ)
  @Get(':id/links')
  @ApiOperation({ summary: 'Delegations held by one master account, revoked ones included' })
  links(@Param('id', ParseUUIDPipe) id: string) {
    return this.masters.links(id);
  }

  @RequirePermissions(Permission.MASTER_READ)
  @Get(':id/desk')
  @ApiOperation({
    summary: "One desk's book: every account it reaches, its exposure, and the totals",
  })
  desk(@Param('id', ParseUUIDPipe) id: string): Promise<DeskView> {
    return this.desks.view(id);
  }

  @RequirePermissions(Permission.MASTER_MANAGE)
  @Post()
  @ApiOperation({ summary: 'Create a master account' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateMasterDto) {
    return this.masters.create(user.id, body);
  }

  @RequirePermissions(Permission.MASTER_MANAGE)
  @Post(':id/links')
  @ApiOperation({ summary: 'Grant a master account access to one trading account' })
  grant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GrantLinkDto,
  ) {
    return this.masters.grantLink(user.id, id, body);
  }

  @RequirePermissions(Permission.MASTER_MANAGE)
  @Delete(':id/links/:accountId')
  @ApiOperation({ summary: 'Revoke a delegation; the record of it is kept' })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.masters.revokeLink(user.id, id, accountId);
  }
}
