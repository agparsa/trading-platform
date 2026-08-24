import { Global, Module } from '@nestjs/common';
import { EventsService } from './events.service';

/**
 * Global on purpose.
 *
 * The trading services publish events and the realtime gateway consumes them.
 * If the publisher lived inside the realtime module, trading would have to
 * import realtime and realtime would have to import trading — a cycle that says
 * the boundary is in the wrong place. Making the bus itself ambient, like the
 * logger or the audit trail, keeps the dependency arrows pointing one way.
 */
@Global()
@Module({
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
