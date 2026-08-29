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
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QueueName);
