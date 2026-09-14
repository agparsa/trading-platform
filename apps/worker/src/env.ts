import { z } from 'zod';
import { isCronPattern } from '@tp/scheduling-core';

/**
 * A cron setting, refused at boot if it is not one.
 *
 * `cron-parser` — which is BullMQ's, and therefore the thing that decides when
 * these actually fire — accepts some four-field patterns and shifts the fields.
 * `0 3 * *`, written by somebody who meant "three in the morning" and
 * miscounted, is accepted, first fires three weeks later, and then runs **every
 * minute**: swap accrual charging overnight financing fourteen hundred times a
 * day, with nothing in any log looking wrong. See the measured table in
 * `scheduling-core/src/lateness.ts`.
 *
 * A validator here turns that into a container that will not start, which is
 * the only version of this failure anybody would notice.
 */
const cron = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine(isCronPattern, {
      message:
        'is not a cron pattern (five fields, or six with seconds). A four-field pattern parses and fires every minute.',
    });

/** The worker needs strictly less configuration than the API. Same discipline. */
export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().startsWith('postgresql://'),

  /**
   * The connection tenant work uses, if it differs from `DATABASE_URL`.
   *
   * The worker needs this more than the API does, not less. It has no request
   * and no middleware, so nothing external puts a tenant in scope; a job that
   * queried without one would read every firm's rows and look entirely normal
   * doing it. Row-level security refuses that, but only for a role that does not
   * own the tables — which is what this points at. See `docs/multi-tenancy.md`.
   */
  DATABASE_URL_TENANT: z.string().startsWith('postgresql://').optional(),
  DATABASE_TENANT_POOLS: z.coerce.number().int().min(1).default(16),

  REDIS_URL: z.string().startsWith('redis://'),
  TRADING_SERVER_TIMEZONE: z.string().default('UTC'),

  /**
   * Weekday that carries the weekend's financing, 0 = Sunday. Wednesday (3) is
   * the near-universal convention: a position held then is financed for three
   * days because settlement rolls over the weekend. Set to -1 to charge one
   * night every day.
   */
  SWAP_TRIPLE_DAY: z.coerce.number().int().min(-1).max(6).default(3),

  // Cron expressions are evaluated in TRADING_SERVER_TIMEZONE, not the host's.
  SWAP_ACCRUAL_CRON: cron('0 0 * * *'),
  RECONCILIATION_CRON: cron('15 * * * *'),
  MAINTENANCE_CRON: cron('30 * * * *'),
  // Every minute: a venue that has been down for fifty seconds is worth
  // knowing about, and the monitor's breaker is what stops this hammering.
  BROKER_HEALTH_CRON: cron('* * * * *'),
  // The outbox relay. Frequent, because it is the durable copy of events a
  // subscriber is waiting on; the backoff lives on the row, not here.
  OUTBOX_RELAY_CRON: cron('* * * * *'),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(200),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),

  // Webhook deliveries (§49). Every minute like the relay; the backoff between
  // attempts lives on the row. See docs/webhooks.md.
  WEBHOOK_DELIVERY_CRON: cron('* * * * *'),
  WEBHOOK_BATCH_SIZE: z.coerce.number().int().min(1).max(2000).default(100),
  /** Attempts per delivery, the first included. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  /** Deliveries in a row that must exhaust their attempts before the endpoint is switched off. */
  WEBHOOK_DISABLE_AFTER_FAILURES: z.coerce.number().int().min(1).max(100).default(5),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /**
   * Whether an `http://` receiver is allowed. Off in every real deployment: a
   * signed event over plain HTTP is a signed event anybody on the path can
   * read. On only for a local test receiver.
   */
  WEBHOOK_ALLOW_HTTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * How long identity documents are kept after a record is decided. Must agree
   * with the API's value: the API states the policy to the person, the worker
   * applies it. Five years is the common regulatory floor.
   */
  KYC_DOCUMENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(7300).default(1826),

  /**
   * Whether this worker sends push notifications at all.
   *
   * Off by default, and when off every push is recorded as SKIPPED rather than
   * SENT — so an unconfigured deployment looks unconfigured in the admin
   * statistics instead of looking perfect.
   */
  PUSH_ENABLED: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(false)
    .transform((value) => value === true || value === 'true'),

  /**
   * A Google service-account JSON blob, verbatim. Serves Android and web.
   *
   * Contains a private key, so it belongs in secret management and never in an
   * image, a log or a repository.
   */
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

  /**
   * APNs credentials as JSON: `keyId`, `teamId`, `privateKey` (the .p8
   * contents), `bundleId`, and `production`. Serves iOS.
   *
   * iOS does not go through FCM, and the reason is what the client holds:
   * Expo's `getDevicePushTokenAsync()` returns an FCM registration token on
   * Android and a *raw APNs token* on iOS. FCM cannot send to the latter.
   */
  APNS_CREDENTIALS_JSON: z.string().optional(),

  /**
   * The Android notification channel trading notices are posted to.
   *
   * Channels are declared by the app, and a message naming a channel the app
   * has not created is delivered silently on Android 8 and later — which is the
   * quietest possible failure for a margin call.
   */
  PUSH_ANDROID_CHANNEL_ID: z.string().default('trading'),

  /**
   * The keys used to open sealed push tokens.
   *
   * The same list the API seals them with. Without it the worker can read the
   * device rows and not the tokens in them.
   */
  SECRET_ENCRYPTION_KEYS: z.string().optional(),

  /**
   * What this process does (§77): `all` schedules and processes every queue;
   * `scheduler` only registers the schedules; `processor` only processes, the
   * queues optionally narrowed by WORKER_QUEUES. See `roles.ts`.
   */
  WORKER_ROLE: z.enum(['all', 'scheduler', 'processor']).default('all'),
  /** Comma-separated queue names a processor takes. Unset means every queue. */
  WORKER_QUEUES: z.string().optional(),

  /** Runs the jobs once at startup. Development convenience; never in production. */
  RUN_JOBS_ON_BOOT: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(false)
    .transform((value) => value === true || value === 'true'),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function validateEnv(raw: Record<string, unknown>): WorkerEnv {
  const result = workerEnvSchema.safeParse(raw);
  if (!result.success) {
    const fields = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid worker environment configuration:\n  ${fields}`);
  }

  /**
   * Cross-field checks the schema cannot express.
   *
   * Refusing to boot beats booting and discovering it on the first margin call
   * that should have woken somebody's phone. Both of these are configuration
   * mistakes whose symptom is silence, which is the hardest kind to notice.
   */
  const env = result.data;
  if (env.PUSH_ENABLED) {
    if (env.SECRET_ENCRYPTION_KEYS === undefined) {
      throw new Error(
        'PUSH_ENABLED requires SECRET_ENCRYPTION_KEYS — the same keys the API seals push tokens with. ' +
          'Without them this worker can read the device rows and not the tokens in them.',
      );
    }
    if (env.FCM_SERVICE_ACCOUNT_JSON === undefined && env.APNS_CREDENTIALS_JSON === undefined) {
      throw new Error(
        'PUSH_ENABLED requires FCM_SERVICE_ACCOUNT_JSON (Android and web) or ' +
          'APNS_CREDENTIALS_JSON (iOS), or both. Set PUSH_ENABLED=false to run without push.',
      );
    }
  }
  return env;
}
