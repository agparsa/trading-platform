import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrokerCredentialKind } from '@tp/broker-sdk';
import { Permission } from '@tp/shared-types';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { SessionOnly } from '../common/decorators/session-only.decorator';
import {
  BrokerConnectionsService,
  type ConnectionTestResult,
  type ConnectionView,
  type ConnectorView,
} from './broker-connections.service';
import { BrokerInboxService, type InboxPage } from './broker-inbox.service';
import {
  BrokerMappingService,
  type CatalogueEntry,
  type MappingView,
  type SyncReport,
} from './broker-mapping.service';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    adapterKind: z.string().trim().min(1).max(40),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const credentialsSchema = z
  .object({
    kind: z.nativeEnum(BrokerCredentialKind),
    /**
     * The venue's own field names and values. Validated against what the
     * connector declared it needs, so a typo is refused here rather than
     * failing at the venue with something unhelpful.
     */
    fields: z.record(z.string().min(1).max(64), z.string().min(1).max(4096)),
  })
  .strict();

const enabledSchema = z
  .object({ enabled: z.boolean(), reason: z.string().trim().min(4).max(500) })
  .strict();

const mapSchema = z
  .object({
    symbolCode: z.string().trim().min(1).max(32),
    externalSymbol: z.string().trim().min(1).max(64),
  })
  .strict();

const mappingEnabledSchema = z
  .object({ symbolCode: z.string().trim().min(1).max(32), enabled: z.boolean() })
  .strict();

class CreateConnectionDto extends createZodDto(createSchema) {}
class CredentialsDto extends createZodDto(credentialsSchema) {}
class EnabledDto extends createZodDto(enabledSchema) {}
class MapInstrumentDto extends createZodDto(mapSchema) {}
class MappingEnabledDto extends createZodDto(mappingEnabledSchema) {}

/**
 * A firm's venue connections.
 *
 * Session-only, whole controller. Setting a venue's credentials is the act
 * that decides where a firm's orders go; a bearer credential in a config file
 * must not be able to perform it, and the reading routes sit beside it rather
 * than in a second controller because the panel reads and writes together.
 */
@ApiTags('broker-connections')
@Controller('admin/broker-connections')
@SessionOnly()
export class BrokerConnectionsController {
  constructor(
    private readonly connections: BrokerConnectionsService,
    private readonly mappings: BrokerMappingService,
    private readonly inbox: BrokerInboxService,
  ) {}

  @Get('connectors')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({ summary: 'The connectors this build can make, and the fields each needs' })
  connectors(): { connectors: readonly ConnectorView[] } {
    return { connectors: this.connections.connectors() };
  }

  @Get()
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({ summary: "The firm's connections, their health, and credential metadata" })
  async list(): Promise<{ connections: readonly ConnectionView[] }> {
    return { connections: await this.connections.list() };
  }

  @Get(':id')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({
    summary: 'One connection, with every credential it has ever had (metadata only)',
  })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ConnectionView> {
    return this.connections.get(id);
  }

  @Post()
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({ summary: 'Create a connection to a venue this build has a connector for' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: CreateConnectionDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<ConnectionView> {
    return this.connections.create(actor.id, body);
  }

  @Post(':id/credentials')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({
    summary: 'Set or rotate the credentials. Sealed at rest; never returned by any route.',
  })
  setCredentials(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CredentialsDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<ConnectionView> {
    return this.connections.setCredentials(actor.id, id, body);
  }

  @Post(':id/enabled')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({ summary: 'Enable or disable a connection, with a reason' })
  setEnabled(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EnabledDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<ConnectionView> {
    return this.connections.setEnabled(actor.id, id, body.enabled, body.reason);
  }

  @Post(':id/test')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({ summary: 'Connect now, ask what the venue supports, and record the verdict' })
  test(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<ConnectionTestResult> {
    return this.connections.test(actor.id, id);
  }

  // ---- Instrument mappings ------------------------------------------------

  @Get(':id/mappings')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({ summary: 'What this venue calls each instrument, and the terms it quoted' })
  async mappingList(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ mappings: readonly MappingView[] }> {
    return { mappings: await this.mappings.list(id) };
  }

  @Get(':id/catalogue')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({
    summary: "The venue's instrument catalogue, read live, with what is already mapped marked",
  })
  async catalogue(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ instruments: readonly CatalogueEntry[] }> {
    return { instruments: await this.mappings.catalogue(id) };
  }

  @Get(':id/mappings/suggestions')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({
    summary: 'Candidate pairings by normalised name. A shortlist for a person, never a mapping.',
  })
  async suggestions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ suggestions: readonly { symbolCode: string; externalSymbol: string }[] }> {
    return { suggestions: await this.mappings.suggest(id) };
  }

  @Post(':id/mappings')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({ summary: "Map one instrument to this venue's name for it" })
  map(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MapInstrumentDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<MappingView> {
    return this.mappings.map(actor.id, id, body);
  }

  @Post(':id/mappings/enabled')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({ summary: 'Turn one mapped instrument on or off for this venue' })
  setMappingEnabled(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MappingEnabledDto,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<MappingView> {
    return this.mappings.setEnabled(actor.id, id, body.symbolCode, body.enabled);
  }

  @Post(':id/mappings/sync')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({
    summary: "Re-read the venue's terms into every mapping and report what moved. Repairs nothing.",
  })
  syncMappings(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<SyncReport> {
    return this.mappings.sync(actor.id, id);
  }

  // ---- The inbox ----------------------------------------------------------

  @Get(':id/inbox')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({ summary: 'What this venue has sent, most recent first' })
  inboxList(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ): Promise<InboxPage> {
    return this.inbox.list(id, toLimit(limit, 100));
  }

  @Get(':id/inbox/pending')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_READ)
  @ApiOperation({ summary: "Not yet applied, in the venue's own ordering" })
  inboxPending(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ): Promise<InboxPage> {
    return this.inbox.pending(id, toLimit(limit, 200));
  }

  @Post(':id/inbox/:eventId/replay')
  @RequirePermissions(Permission.BROKER_CONNECTIONS_MANAGE)
  @ApiOperation({
    summary: 'Put a failed event back to be applied by corrected code. It is never deleted.',
  })
  async replay(
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @IdempotencyKey() _idempotencyKey: string,
  ): Promise<{ replayed: true }> {
    await this.inbox.replay(eventId);
    return { replayed: true };
  }
}

/** A query-string limit, or the default. Never a NaN reaching a `take`. */
function toLimit(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
