import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/**
 * Global because the outbox belongs wherever a domain change is written, and
 * threading it through every module that has a transaction would be noise
 * around something every one of them needs.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
