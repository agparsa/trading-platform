/**
 * Queue names, declared in one place so the API (producer) and the worker
 * (consumer) cannot drift apart on a string literal.
 *
 * Nothing here is a substitute for the trading engine's synchronous path: an
 * order fill, a stop-loss trigger and a ledger write happen inline, inside a
 * database transaction. Queues carry work that is genuinely deferrable —
 * snapshots, swap accrual, reconciliation, notifications.
 */
export const QueueName = {
  /** Nightly swap accrual for positions held overnight. */
  SWAP_ACCRUAL: 'swap-accrual',
  /** Periodic account snapshots for charts and reconciliation. */
  /** Cross-checks internal state against the market-data provider. */
  RECONCILIATION: 'reconciliation',
  /** Expires idempotency records past their TTL. */
  IDEMPOTENCY_SWEEP: 'idempotency-sweep',
  /** Outbound notifications (email, in-app). */
  NOTIFICATIONS: 'notifications',
  /** Asks every enabled venue connection how it is, and records the answer. */
  BROKER_HEALTH: 'broker-health',
  /** Hands on what the transactional outbox holds. */
  OUTBOX_RELAY: 'outbox-relay',
  /** Sends what the outbox relay recorded as owed to each firm's webhook endpoints. */
  WEBHOOK_DELIVERY: 'webhook-delivery',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QueueName);

/**
 * Defaults every queue inherits.
 *
 * `removeOnFail: false` is deliberate — a failed financial job must stay
 * visible in the dead-letter set until a human has looked at it.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: false,
} as const;
