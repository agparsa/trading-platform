import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@tp/shared-types';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  PushDeliveriesService,
  type PushDeliverySummary,
  type PushDeliveryView,
} from './push-deliveries.service';

const STATUSES = ['PENDING', 'SENT', 'FAILED', 'DROPPED', 'SKIPPED'] as const;

const deliveriesSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    userId: z.string().uuid().optional(),
    /** Prefix of the notification kind, e.g. `order.` */
    kind: z.string().min(1).max(64).optional(),
    errorCode: z.string().min(1).max(64).optional(),
    /** ISO-8601; the OpenAPI document cannot describe a Date. */
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

class DeliveriesQueryDto extends createZodDto(deliveriesSchema) {}

/**
 * The firm's push deliveries: what was tried, for whom, and what the provider
 * said. For support ("I never got the alert"), for whoever watches the estate
 * of devices ("half of Android went DROPPED overnight"), and for nobody to
 * edit — see `PushDeliveriesService`.
 */
@ApiTags('admin-notifications')
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly deliveries: PushDeliveriesService) {}

  @RequirePermissions(Permission.NOTIFICATIONS_READ_ANY)
  @Get('deliveries')
  @ApiOperation({ summary: 'Push delivery records, filtered and newest first' })
  async list(
    @Query() query: DeliveriesQueryDto,
  ): Promise<{ deliveries: readonly PushDeliveryView[] }> {
    return {
      deliveries: await this.deliveries.list({
        ...query,
        since: query.since === undefined ? undefined : new Date(query.since),
      }),
    };
  }

  @RequirePermissions(Permission.NOTIFICATIONS_READ_ANY)
  @Get('deliveries/summary')
  @ApiOperation({
    summary: 'Delivery counts by outcome, error code and platform over the last day',
  })
  summary(@Query('since') since?: string): Promise<PushDeliverySummary> {
    const parsed = since === undefined ? Number.NaN : Date.parse(since);
    return this.deliveries.summary(
      Number.isFinite(parsed) ? new Date(parsed) : new Date(Date.now() - 86_400_000),
    );
  }
}
