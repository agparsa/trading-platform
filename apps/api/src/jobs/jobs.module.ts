import { Module } from '@nestjs/common';
import { QueuePublisher } from './queue-publisher.service';

/**
 * One publisher, one Redis connection, one set of queue handles.
 *
 * `QueuePublisher` was listed in `providers` by two modules, so Nest built two
 * of them: two BullMQ connections and two sets of `Queue` objects in every API
 * process, for a service that holds no per-module state. `NotificationsModule`
 * already imported `ReconciliationModule` to avoid a third, with a comment
 * saying "one publisher, one connection" — the intent was written down and the
 * wiring did not carry it.
 *
 * It lives in a module of its own rather than in one of theirs because a
 * publisher is not part of reconciliation or of reports, and because the
 * metrics pass needs it too: whatever is sitting in a dead-letter set is a fact
 * about the deployment, not about whoever happens to enqueue.
 */
@Module({
  providers: [QueuePublisher],
  exports: [QueuePublisher],
})
export class JobsModule {}
