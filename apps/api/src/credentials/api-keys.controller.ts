import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { clientAddress, RequestWithContext } from '../common/request-context';
import { CredentialsService, type ApiKeyView } from './credentials.service';
import { MintApiKeyDto, RevokeOwnKeyDto } from './dto/credentials.dto';

/**
 * A person's own API keys.
 *
 * Session-only, whole controller: a key must not be able to mint, list or
 * revoke keys. The response to `POST` carries the secret, once. It is not in
 * the audit row, not in the log, and not in any later response — there is
 * nowhere it could come from.
 */
@ApiTags('api-keys')
@Controller('api-keys')
@SessionOnly()
export class ApiKeysController {
  constructor(private readonly credentials: CredentialsService) {}

  @Get()
  @RequirePermissions(Permission.API_KEYS_MANAGE)
  @ApiOperation({ summary: 'Your keys, newest first, with what each has done this week' })
  async mine(@CurrentUser() user: AuthenticatedUser): Promise<{ keys: readonly ApiKeyView[] }> {
    return { keys: await this.credentials.listApiKeys(user.id) };
  }

  @Post()
  @RequirePermissions(Permission.API_KEYS_MANAGE)
  @ApiOperation({ summary: 'Mint a key. The secret is in this response and nowhere else, ever.' })
  async mint(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MintApiKeyDto,
    @Req() request: RequestWithContext,
  ): Promise<{ key: ApiKeyView; token: string }> {
    return this.credentials.mintApiKey({
      user: { id: user.id, role: user.role as never },
      name: body.name,
      permissions: body.permissions,
      expiresInDays: body.expiresInDays,
      rateLimitPerMinute: body.rateLimitPerMinute,
      password: body.password,
      ip: clientAddress(request),
    });
  }

  @Post(':id/revoke')
  @RequirePermissions(Permission.API_KEYS_MANAGE)
  @ApiOperation({ summary: 'End one of your keys. Immediate, and not reversible.' })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RevokeOwnKeyDto,
  ): Promise<ApiKeyView> {
    return this.credentials.revokeApiKey({ userId: user.id, id, reason: body.reason });
  }
}
