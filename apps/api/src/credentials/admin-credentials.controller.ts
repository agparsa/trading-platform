import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { clientAddress, RequestWithContext } from '../common/request-context';
import {
  CredentialsService,
  type AdminApiKeyView,
  type ServiceTokenView,
} from './credentials.service';
import { MintServiceTokenDto, RevokeCredentialDto } from './dto/credentials.dto';

/**
 * Every credential in the tenant, for the people who answer for it.
 *
 * Session-only, whole controller, for the same reason as the holder's own:
 * nothing that can be presented as a bearer may reach the place bearers are
 * made.
 */
@ApiTags('admin-credentials')
@Controller('admin')
@SessionOnly()
export class AdminCredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get('api-keys')
  @RequirePermissions(Permission.API_KEYS_READ_ANY)
  @ApiOperation({ summary: "Everyone's keys: holder, capabilities, last use. Never the secret." })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: String })
  async keys(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ): Promise<{ keys: readonly AdminApiKeyView[] }> {
    const parsed = limit === undefined ? undefined : Number.parseInt(limit, 10);
    return {
      keys: await this.credentials.listAllApiKeys({
        search,
        limit: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
      }),
    };
  }

  @Post('api-keys/:id/revoke')
  @RequirePermissions(Permission.API_KEYS_REVOKE_ANY)
  @ApiOperation({ summary: "Revoke anyone's key. The holder is told, with the reason." })
  async revokeKey(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeCredentialDto,
  ): Promise<AdminApiKeyView> {
    return this.credentials.revokeAnyApiKey({ actorId: actor.id, id, reason: body.reason });
  }

  @Get('service-tokens')
  @RequirePermissions(Permission.SERVICE_TOKENS_MANAGE)
  @ApiOperation({ summary: "The firm's machine identities" })
  async tokens(): Promise<{ tokens: readonly ServiceTokenView[] }> {
    return { tokens: await this.credentials.listServiceTokens() };
  }

  @Post('service-tokens')
  @RequirePermissions(Permission.SERVICE_TOKENS_MANAGE)
  @ApiOperation({
    summary: 'Mint a service token. The secret is in this response and nowhere else.',
  })
  async mintToken(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: MintServiceTokenDto,
    @Req() request: RequestWithContext,
  ): Promise<{ token: ServiceTokenView; secret: string }> {
    return this.credentials.mintServiceToken({
      actor: { id: actor.id, role: actor.role as never },
      name: body.name,
      description: body.description,
      permissions: body.permissions,
      expiresInDays: body.expiresInDays,
      rateLimitPerMinute: body.rateLimitPerMinute,
      ip: clientAddress(request),
    });
  }

  @Post('service-tokens/:id/revoke')
  @RequirePermissions(Permission.SERVICE_TOKENS_MANAGE)
  @ApiOperation({ summary: 'Revoke a service token. Immediate.' })
  async revokeToken(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeCredentialDto,
  ): Promise<ServiceTokenView> {
    return this.credentials.revokeServiceToken({ actorId: actor.id, id, reason: body.reason });
  }
}
