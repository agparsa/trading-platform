import { z } from 'zod';

/**
 * Environment contract.
 *
 * Parsed once at boot; the process refuses to start if anything is missing or
 * malformed. A trading server that comes up with a missing JWT secret and
 * discovers it on the first login is not an acceptable failure mode.
 */
const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: port.default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_GLOBAL_PREFIX: z.string().default('api'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().startsWith('postgresql://'),
  REDIS_URL: z.string().startsWith('redis://'),

  // Long enough that a brute-force is hopeless; refuse to boot on a short one.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  MARKET_DATA_PROVIDER: z.enum(['internal-simulator', 'external']).default('internal-simulator'),
  MARKET_SIMULATOR_TICK_MS: z.coerce.number().int().min(10).default(250),
  MARKET_SIMULATOR_SEED: z.coerce.number().int().default(20260821),

  TRADING_SERVER_TIMEZONE: z.string().default('UTC'),
  DEFAULT_ACCOUNT_LEVERAGE: z.coerce.number().int().min(1).default(100),
  IDEMPOTENCY_KEY_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),

  RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_ORDERS_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(1).default(600),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    // Print the field names only. Values are secrets.
    const fields = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${fields}`);
  }
  return result.data;
}

/** Split the comma-separated allowlist. An empty entry is dropped, never
 * turned into a wildcard — a stray comma must not open the API to every origin. */
export function corsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
