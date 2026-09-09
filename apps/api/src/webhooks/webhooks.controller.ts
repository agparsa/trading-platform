import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Permission } from '@tp/shared-types';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { WebhooksService } from './webhooks.service';

const createSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    description: z.string().trim().min(1).max(500),
    /** Empty means every event, including ones added later. */
    events: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  })
  .strict();
const toggleSchema = z.object({ enabled: z.boolean() }).strict();
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

class CreateEndpointDto extends createZodDto(createSchema) {}
class ToggleDto extends createZodDto(toggleSchema) {}
class ListDeliveriesDto extends createZodDto(listSchema) {}

/**
 * Where this firm's events are sent (§49).
 *
 * `@SessionOnly()` throughout. An endpoint is a place every order fill and
 * balance change will be posted to; a long-lived key that could register one
 * would be exfiltration of every event from then on.
 */
@ApiTags('webhooks')
@Controller('admin/webhooks')
@SessionOnly()
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('events')
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'The event types an endpoint may subscribe to' })
  eventTypes() {
    return { events: this.webhooks.eventTypes() };
  }

  @Get()
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'The firm’s webhook endpoints. Secrets are shown as their last four characters.',
  })
  list() {
    return this.webhooks.list();
  }

  @Post()
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Register an endpoint. The secret is in this response and nowhere else, ever.',
  })
  create(@CurrentUser() actor: AuthenticatedUser, @Body() body: CreateEndpointDto) {
    return this.webhooks.create({
      actorId: actor.id,
      url: body.url,
      description: body.description,
      events: body.events,
    });
  }

  @Post(':id/enabled')
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Turn an endpoint on or off. Turning on re-schedules what was left undelivered.',
  })
  setEnabled(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ToggleDto,
  ) {
    return this.webhooks.setEnabled({ actorId: actor.id, id, enabled: body.enabled });
  }

  @Post(':id/rotate-secret')
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Issue a new secret. The old one keeps signing for a day; the new one is shown once.',
  })
  rotateSecret(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.rotateSecret({ actorId: actor.id, id });
  }

  @Delete(':id')
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Remove an endpoint and its delivery log. The audit row remains.' })
  async remove(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.webhooks.remove(actor.id, id);
    return { ok: true };
  }

  @Get(':id/deliveries')
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'The delivery log for one endpoint, newest first' })
  deliveries(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListDeliveriesDto) {
    return this.webhooks.deliveries(id, query.limit);
  }

  @Post('deliveries/:id/replay')
  @SessionOnly()
  @RequirePermissions(Permission.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Send an event again, as a new delivery that records it was asked for' })
  replay(@CurrentUser() actor: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.replay({ actorId: actor.id, deliveryId: id });
  }
}
