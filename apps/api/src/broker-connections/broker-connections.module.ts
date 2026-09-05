import { Module } from '@nestjs/common';
import { BrokerAdapterRegistry } from '@tp/broker-sdk';
import { BrokerConnectionsController } from './broker-connections.controller';
import { BrokerConnectionsService } from './broker-connections.service';
import { BrokerInboxService } from './broker-inbox.service';
import { BrokerMappingService } from './broker-mapping.service';

/**
 * The registry is a provider rather than a global: a deployment that ships a
 * venue connector registers it here, in one visible place, and the tests can
 * hand in a registry of their own.
 */
@Module({
  controllers: [BrokerConnectionsController],
  providers: [
    BrokerConnectionsService,
    BrokerInboxService,
    BrokerMappingService,
    { provide: BrokerAdapterRegistry, useFactory: () => new BrokerAdapterRegistry() },
  ],
  exports: [
    BrokerConnectionsService,
    BrokerInboxService,
    BrokerMappingService,
    BrokerAdapterRegistry,
  ],
})
export class BrokerConnectionsModule {}
