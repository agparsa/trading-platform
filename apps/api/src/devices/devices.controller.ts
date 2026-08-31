import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DevicePlatform } from '@tp/shared-types';
import type { Request } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { AuditService } from '../common/audit/audit.service';
import { DevicesService } from './devices.service';

const registerSchema = z
  .object({
    platform: z.enum([DevicePlatform.IOS, DevicePlatform.ANDROID, DevicePlatform.WEB]),
    /**
     * Bounded because it is a client-supplied key in a unique index. An
     * unbounded string there is an invitation to fill the index with one row per
     * request.
     */
    installationId: z.string().min(8).max(200),
    /**
     * FCM registration tokens run to a few hundred characters and APNs tokens
     * to 64 hex; 4096 is generous for both and still refuses a payload.
     */
    pushToken: z.string().min(8).max(4096).nullish(),
    appVersion: z.string().max(40).nullish(),
    osVersion: z.string().max(40).nullish(),
    model: z.string().max(80).nullish(),
    locale: z.string().max(20).nullish(),
  })
  .strict();

class RegisterDeviceDto extends createZodDto(registerSchema) {}

/**
 * A person's own devices.
 *
 * Self-service throughout: there is no notion of registering a device for
 * somebody else, so there is no permission that could grant it. Every route
 * takes the user from the authenticated context and scopes its query by it —
 * never from a parameter, which a client could name.
 */
@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Devices registered to the signed-in user' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.devices.list(user.id);
  }

  @SelfService()
  @Post()
  @ApiOperation({ summary: 'Register this installation, or refresh its push token' })
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RegisterDeviceDto,
    @Req() request: Request,
  ) {
    const device = await this.devices.register(user.id, {
      platform: body.platform,
      installationId: body.installationId,
      pushToken: body.pushToken ?? null,
      appVersion: body.appVersion ?? null,
      osVersion: body.osVersion ?? null,
      model: body.model ?? null,
      locale: body.locale ?? null,
    });

    /**
     * A new device on an account is a security event, not a settings change.
     *
     * It is the first thing an investigator looks for after a credential theft,
     * and the fingerprint rather than the token is what goes in the record —
     * `redact` would catch the token anyway, and relying on that would be
     * relying on a safety net instead of not walking off the roof.
     */
    await this.audit.record({
      actorId: user.id,
      actorType: 'USER',
      action: 'DEVICE_REGISTERED',
      resourceType: 'Device',
      resourceId: device.id,
      after: {
        platform: device.platform,
        model: device.model,
        appVersion: device.appVersion,
        hasPushToken: device.hasPushToken,
        pushTokenFingerprint: device.pushTokenFingerprint,
      },
      requestId: requestIdOf(request),
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });

    return device;
  }

  @SelfService()
  @Delete(':id')
  @ApiOperation({ summary: 'Stop sending notifications to a device' })
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ) {
    const result = await this.devices.deactivate(user.id, id);
    await this.audit.record({
      actorId: user.id,
      actorType: 'USER',
      action: 'DEVICE_DEACTIVATED',
      resourceType: 'Device',
      resourceId: id,
      requestId: requestIdOf(request),
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    return result;
  }
}

function requestIdOf(request: Request): string | null {
  const header = request.get('x-request-id');
  return header === undefined || header.length === 0 ? null : header;
}
