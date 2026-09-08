import { Global, Module } from '@nestjs/common';
import { LeadershipService } from './leadership.service';
import { LeadershipController } from './leadership.controller';

/**
 * Global, because the loops that need a lease are spread across modules —
 * market data in one, the trigger engine in another — and threading an import
 * through each of them would mean every future singleton loop has to remember
 * to. A loop that forgets does not fail: it runs everywhere.
 */
@Global()
@Module({
  providers: [LeadershipService],
  controllers: [LeadershipController],
  exports: [LeadershipService],
})
export class LeadershipModule {}
