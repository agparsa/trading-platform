import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExecutionMode, Permission } from '@tp/shared-types';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import { BrokersService, type BrokerCreated, type BrokerView } from './brokers.service';

const createBrokerSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and hyphens'),
    name: z.string().trim().min(1).max(120),
    legalName: z.string().trim().min(1).max(200).optional(),
    primaryHost: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(/^[a-z0-9.-]+$/, 'a hostname, without scheme or port')
      .optional(),
    defaultExecutionMode: z.nativeEnum(ExecutionMode).optional(),
    ownerInviteTtlHours: z.coerce.number().int().min(1).max(720).optional(),
  })
  .strict();

const brokerStatusSchema = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']),
    reason: z.string().trim().min(4).max(500),
  })
  .strict();

class CreateBrokerDto extends createZodDto(createBrokerSchema) {}
class BrokerStatusDto extends createZodDto(brokerStatusSchema) {}

/**
 * The platform's view of its brokers. Session-only: creating a firm and
 * appointing its owner are a person's acts, and the owner's invitation is a
 * secret shown once.
 */
@ApiTags('brokers')
@Controller('admin/brokers')
@SessionOnly()
export class BrokersController {
  constructor(private readonly brokers: BrokersService) {}

  @Get()
  @RequirePermissions(Permission.TENANTS_READ)
  @ApiOperation({ summary: 'Every broker on the platform' })
  async list(): Promise<{ brokers: readonly BrokerView[] }> {
    return { brokers: await this.brokers.list() };
  }

  @Get(':id')
  @RequirePermissions(Permission.TENANTS_READ)
  @ApiOperation({ summary: 'One broker' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BrokerView> {
    return this.brokers.get(id);
  }

  @Post()
  @RequirePermissions(Permission.TENANTS_MANAGE)
  @ApiOperation({
    summary: "Create a broker. The owner's invitation code is in the response and nowhere else.",
  })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: CreateBrokerDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<BrokerCreated> {
    return this.brokers.create({ id: actor.id, role: actor.role }, body);
  }

  @Post(':id/status')
  @RequirePermissions(Permission.TENANTS_MANAGE)
  @ApiOperation({ summary: 'Suspend, reinstate or close a broker' })
  setStatus(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BrokerStatusDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<BrokerView> {
    return this.brokers.setStatus({ id: actor.id }, id, body.status, body.reason);
  }
}
