/**
 * Queue names, shared with the worker.
 *
 * Deliberately duplicated from `apps/worker/src/queues.ts` rather than imported
 * across an application boundary: these two processes deploy independently, and
 * a compile-time link between them would mean the API could not be released
 * without the worker. The names are a *wire contract*, and the test in
 * `queue-names.test.ts` reads both files and fails if they drift.
 */
export const QueueName = {
  SWAP_ACCRUAL: 'swap-accrual',
  RECONCILIATION: 'reconciliation',
  IDEMPOTENCY_SWEEP: 'idempotency-sweep',
  NOTIFICATIONS: 'notifications',
  /**
   * The worker's venue-connection health sweep. Named here for the parity
   * test rather than because the API enqueues it: nothing on a request path
   * should be able to make the platform call a venue on demand except the
   * connection test route, which does it inline and inside the breaker.
   */
  BROKER_HEALTH: 'broker-health',
  /** The worker's outbox relay. Named here for the same parity test. */
  OUTBOX_RELAY: 'outbox-relay',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QueueName);
