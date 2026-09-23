import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { SelfService } from '../common/decorators/self-service.decorator';
import { PriceAlertsService } from './price-alerts.service';

/**
 * `price` is a string, and stays one all the way to the NUMERIC column.
 *
 * A level a trader typed has to be compared as they typed it. Accepting a
 * number here would put it through a float before it ever reached the database,
 * and an alert set at 4600 that fires at 4599.9999 is a bug nobody can explain
 * to the person it happened to.
 */
const createSchema = z
  .object({
    symbol: z.string().trim().min(1).max(32),
    condition: z.enum(['ABOVE', 'BELOW']),
    source: z.enum(['BID', 'ASK', 'MID']).optional(),
    price: z
      .string()
      .trim()
      .regex(/^\d+(\.\d+)?$/, 'A price alert level must be a positive decimal'),
    note: z.string().trim().max(280).nullable().optional(),
    /**
     * An ISO-8601 string, parsed in the handler rather than by the schema.
     *
     * `z.coerce.date()` would be shorter and would take the whole API down: the
     * OpenAPI document is generated from these schemas at boot, and a `Date`
     * has no JSON Schema representation, so the process throws before it
     * listens. It is also the more honest wire type — JSON has no date, and a
     * client reading the document should be told to send a string.
     */
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const listSchema = z
  .object({ status: z.enum(['ACTIVE', 'TRIGGERED', 'CANCELLED', 'EXPIRED']).optional() })
  .strict();

class CreateAlertDto extends createZodDto(createSchema) {}
class ListAlertsDto extends createZodDto(listSchema) {}

interface AlertView {
  readonly id: string;
  readonly symbol: string;
  readonly condition: 'ABOVE' | 'BELOW';
  readonly source: 'BID' | 'ASK' | 'MID';
  readonly price: string;
  readonly status: string;
  readonly note: string | null;
  readonly expiresAt: Date | null;
  readonly triggeredAt: Date | null;
  readonly triggeredPrice: string | null;
  readonly createdAt: Date;
}

/**
 * Levels a trader asked to be told about.
 *
 * `@SelfService()` on the class and on every route. These are a person's own
 * watchlist notes; there is nothing an integration needs here, and a long-lived
 * API key has no business setting or clearing them.
 *
 * Every route is scoped to the caller inside the service's own query rather
 * than by checking ownership after a read. An alert id is a UUID somebody might
 * paste, and "cancel by id" that trusts the id is how one trader silences
 * another's.
 */
@ApiTags('alerts')
@Controller('alerts')
@SelfService()
export class PriceAlertsController {
  constructor(private readonly alerts: PriceAlertsService) {}

  @Get()
  @SelfService()
  @ApiOperation({ summary: 'Your price alerts' })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAlertsDto,
  ): Promise<{ alerts: readonly AlertView[] }> {
    const rows = await this.alerts.list(user.id, query.status);
    return { alerts: rows.map(toView) };
  }

  @Post()
  @SelfService()
  @ApiOperation({ summary: 'Ask to be told when an instrument reaches a level' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAlertDto,
  ): Promise<AlertView> {
    const alert = await this.alerts.create(user.id, {
      symbol: body.symbol,
      condition: body.condition,
      source: body.source,
      price: body.price,
      note: body.note ?? null,
      expiresAt:
        body.expiresAt === null || body.expiresAt === undefined ? null : new Date(body.expiresAt),
    });
    return toView(alert);
  }

  /**
   * `DELETE` cancels rather than deletes.
   *
   * A triggered alert is the record of a notification the trader received, and
   * a fired alert that leaves no trace is a support conversation nobody can
   * settle. Cancelling an active one is the only removal the platform offers.
   */
  @Delete(':id')
  @SelfService()
  @ApiOperation({ summary: 'Stop watching a level' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AlertView> {
    return toView(await this.alerts.cancel(user.id, id));
  }
}

function toView(alert: {
  id: string;
  symbol: string;
  condition: 'ABOVE' | 'BELOW';
  source: 'BID' | 'ASK' | 'MID';
  price: { toString(): string };
  status: string;
  note: string | null;
  expiresAt: Date | null;
  triggeredAt: Date | null;
  triggeredPrice: { toString(): string } | null;
  createdAt: Date;
}): AlertView {
  return {
    id: alert.id,
    symbol: alert.symbol,
    condition: alert.condition,
    source: alert.source,
    price: alert.price.toString(),
    status: alert.status,
    note: alert.note,
    expiresAt: alert.expiresAt,
    triggeredAt: alert.triggeredAt,
    triggeredPrice: alert.triggeredPrice?.toString() ?? null,
    createdAt: alert.createdAt,
  };
}
