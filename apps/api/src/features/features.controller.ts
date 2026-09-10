import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DomainError, Feature, Permission, TradingErrorCode, isFeature } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { FeaturesService } from './features.service';

const setSchema = z
  .object({ enabled: z.boolean(), note: z.string().trim().min(1).max(500) })
  .strict();
class SetFeatureDto extends createZodDto(setSchema) {}

function parseKey(raw: string): Feature {
  if (!isFeature(raw)) {
    throw new DomainError(TradingErrorCode.VALIDATION_FAILED, `No such feature: ${raw}`);
  }
  return raw;
}

/**
 * What a client may read: the effective flags for its own firm. Any signed-in
 * principal, keys included — a script deciding whether to trail a stop needs
 * the same answer a browser does.
 */
@ApiTags('features')
@Controller('features')
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Get()
  @SelfService()
  @ApiOperation({ summary: 'What is switched on for this firm, as a client honours it' })
  async effective() {
    return { features: await this.features.effective() };
  }
}

/**
 * The firm's own flags. `@SessionOnly()`: a flag is a decision a person makes.
 */
@ApiTags('features')
@Controller('admin/features')
@SessionOnly()
export class AdminFeaturesController {
  constructor(private readonly features: FeaturesService) {}

  /**
   * Reading is operations' business — an operator answering "why was that
   * refused" needs to see the flags — while writing stays the owner's.
   */
  @Get()
  @SessionOnly()
  @RequirePermissions(Permission.SYSTEM_OPERATIONS)
  @ApiOperation({
    summary: 'Every flag, its authority, and whether this firm overrides the default',
  })
  list() {
    return this.features.list();
  }

  @Post(':key')
  @SessionOnly()
  @RequirePermissions(Permission.TENANT_SETTINGS_MANAGE)
  @ApiOperation({ summary: 'Set one of the firm’s own flags. A platform flag is refused here.' })
  set(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('key') key: string,
    @Body() body: SetFeatureDto,
  ) {
    return this.features.set({
      actorId: actor.id,
      actorAuthority: 'FIRM',
      key: parseKey(key),
      enabled: body.enabled,
      note: body.note,
    });
  }
}

/**
 * The platform, setting a broker's platform flags. Lives beside the broker
 * routes it belongs with; requires the platform's own capability.
 */
@ApiTags('brokers')
@Controller('admin/brokers')
@SessionOnly()
export class BrokerFeaturesController {
  constructor(
    private readonly features: FeaturesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/features')
  @SessionOnly()
  @RequirePermissions(Permission.TENANTS_READ)
  @ApiOperation({ summary: 'One broker’s flags, as the platform sees them' })
  async list(@Param('id', ParseUUIDPipe) id: string) {
    return this.features.listForBroker(await this.broker(id));
  }

  @Post(':id/features/:key')
  @SessionOnly()
  @RequirePermissions(Permission.TENANTS_MANAGE)
  @ApiOperation({ summary: 'Switch a platform flag on or off for one broker' })
  async set(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() body: SetFeatureDto,
  ) {
    return this.features.setForBroker(
      actor.id,
      await this.broker(id),
      parseKey(key),
      body.enabled,
      body.note,
    );
  }

  private async broker(id: string) {
    const broker = await this.prisma.tenant.findFirst({
      where: { id, kind: 'BROKER' },
      select: { id: true, slug: true, kind: true },
    });
    if (broker === null)
      throw new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'No such broker');
    return { tenantId: broker.id, slug: broker.slug, kind: broker.kind };
  }
}
