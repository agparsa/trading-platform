import { z } from 'zod';

/** The worker needs strictly less configuration than the API. Same discipline. */
export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().startsWith('postgresql://'),
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
  SWAP_ACCRUAL_CRON: z.string().default('0 0 * * *'),
  RECONCILIATION_CRON: z.string().default('15 * * * *'),
  MAINTENANCE_CRON: z.string().default('30 * * * *'),

  /**
   * Which push transport to use.
   *
   * `none` is the default and is honest about it: the no-op provider records
   * every push as SKIPPED rather than SENT, so an unconfigured deployment looks
   * unconfigured in the admin statistics instead of looking perfect.
   */
  PUSH_PROVIDER: z.enum(['none', 'fcm']).default('none'),

  /**
   * A Google service-account JSON blob, verbatim.
   *
   * Required when PUSH_PROVIDER=fcm. Contains a private key, so it belongs in
   * secret management and never in an image, a log or a repository.
   */
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),

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
  if (env.PUSH_PROVIDER === 'fcm') {
    const missing: string[] = [];
    if (env.FCM_SERVICE_ACCOUNT_JSON === undefined) missing.push('FCM_SERVICE_ACCOUNT_JSON');
    if (env.SECRET_ENCRYPTION_KEYS === undefined) missing.push('SECRET_ENCRYPTION_KEYS');
    if (missing.length > 0) {
      throw new Error(
        `PUSH_PROVIDER=fcm requires ${missing.join(' and ')}. ` +
          'Set them, or set PUSH_PROVIDER=none to run without push.',
      );
    }
  }
  return env;
}
