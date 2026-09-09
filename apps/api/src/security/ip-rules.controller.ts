import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import type { RequestWithContext } from '../common/request-context';
import { resolveClientIp } from './client-ip';
import { IpRulesService } from './ip-rules.service';
import type { Env } from '../config/env.schema';

const createSchema = z
  .object({
    cidr: z.string().trim().min(1).max(64),
    kind: z.enum(['ALLOW', 'DENY']),
    /**
     * Defaulted to `STAFF`, the low-risk case. `EVERYONE` includes customers,
     * and a trader travelling is a trader locked out — a business decision the
     * caller has to make on purpose.
     */
    scope: z.enum(['STAFF', 'EVERYONE']).default('STAFF'),
    note: z.string().trim().min(1).max(500),
  })
  .strict();

const toggleSchema = z.object({ enabled: z.boolean() }).strict();

class CreateRuleDto extends createZodDto(createSchema) {}
class ToggleDto extends createZodDto(toggleSchema) {}

/**
 * Where this firm's people may reach it from (§46).
 *
 * `@SessionOnly()` throughout: a long-lived key in a config file must not be
 * able to rewrite the rules about who can reach the platform — that is the one
 * change a stolen key would most want to make.
 *
 * `GET` reports the caller's own address alongside the rules, because the first
 * question anybody writing an allow-list has is "what am I coming from?", and
 * making them guess is how they write one that excludes themselves.
 */
@ApiTags('security')
@Controller('security/ip-rules')
@SessionOnly()
export class IpRulesController {
  constructor(
    private readonly rules: IpRulesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private caller(request: RequestWithContext) {
    return resolveClientIp(
      request.ip,
      request.header('x-forwarded-for'),
      this.config.get('TRUSTED_PROXY_HOPS', { infer: true }),
    );
  }

  @Get()
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'The firm’s IP rules, and the address you are calling from' })
  async list(@Req() request: RequestWithContext) {
    const caller = this.caller(request);
    return {
      /**
       * Said plainly rather than left to be inferred. A screen that lists rules
       * while the platform cannot enforce them is a screen that reassures
       * somebody about a control that is off.
       */
      enforceable: this.rules.enforceable() && caller.trusted,
      yourAddress: caller.address,
      yourAddressTrusted: caller.trusted,
      rules: await this.rules.list(),
    };
  }

  @Post()
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Add a rule — refused if it would shut you out' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithContext,
    @Body() body: CreateRuleDto,
  ) {
    const caller = this.caller(request);
    return this.rules.create({
      actorId: actor.id,
      actorAddress: caller.address,
      actorAddressTrusted: caller.trusted,
      cidr: body.cidr,
      kind: body.kind,
      scope: body.scope,
      note: body.note,
    });
  }

  @Post(':id/enabled')
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Turn a rule on or off. Turning off is never refused.' })
  async setEnabled(
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: RequestWithContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ToggleDto,
  ) {
    const caller = this.caller(request);
    return this.rules.setEnabled({
      actorId: actor.id,
      actorAddress: caller.address,
      actorAddressTrusted: caller.trusted,
      id,
      enabled: body.enabled,
    });
  }

  /** Never refused. The way out of a bad configuration stays open. */
  @Delete(':id')
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({ summary: 'Remove a rule' })
  async remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.rules.remove(actor.id, id);
    return { ok: true };
  }
}
