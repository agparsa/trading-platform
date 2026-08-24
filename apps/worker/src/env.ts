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
  return result.data;
}
