import { z } from 'zod';
import { parseEncryptionKeys } from '@tp/crypto-core';

/**
 * Environment contract.
 *
 * Parsed once at boot; the process refuses to start if anything is missing or
 * malformed. A trading server that comes up with a missing JWT secret and
 * discovers it on the first login is not an acceptable failure mode.
 */
const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    API_PORT: port.default(4000),
    API_HOST: z.string().default('0.0.0.0'),
    API_GLOBAL_PREFIX: z.string().default('api'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),

    DATABASE_URL: z.string().startsWith('postgresql://'),

    /**
     * The connection tenant traffic uses, if it differs from `DATABASE_URL`.
     *
     * Row-level security constrains every role *except* a table's owner, and
     * `DATABASE_URL` is the owner — it has to be, because migrations run
     * through it. So pointing this at a second, unprivileged role is what turns
     * the policies from documentation into enforcement. `pnpm db:roles` creates
     * that role; `docs/multi-tenancy.md` has the deployment step.
     *
     * Unset, everything runs as the owner and the API says so at boot, loudly
     * and once. Set, the API *verifies* at boot that the role really is
     * constrained and refuses to start if it is not — a connection string that
     * claims isolation and does not have it is worse than none, because it is
     * the one people stop checking.
     */
    DATABASE_URL_TENANT: z.string().startsWith('postgresql://').optional(),

    /**
     * How many per-tenant connection pools may be open at once. Each tenant
     * gets its own, because `app.tenant_id` is bound when the connection opens.
     * Total connections are this times `connection_limit`, so it is a budget,
     * not a limit on how many tenants may exist.
     */
    DATABASE_TENANT_POOLS: z.coerce.number().int().min(1).default(32),

    /**
     * What a payer is shown when they choose a bank transfer.
     *
     * Configuration rather than a constant, because a hard-coded IBAN in a
     * repository is somebody else's bank account by the second deployment. Left
     * unset, the instructions say so plainly instead of showing a blank.
     */
    PAYMENT_BANK_DETAILS: z.string().max(2000).optional(),
    /** Currencies this deployment will take money in. */
    PAYMENT_CURRENCIES: z.string().default('USD'),
    /** How long an unpaid payment stays open before the maintenance job expires it. */
    PAYMENT_INTENT_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    /** The largest single deposit this deployment will start. */
    PAYMENT_MAX_AMOUNT: z.string().default('100000'),

    /**
     * How long a verification stays good, in days. Unset means it never lapses.
     *
     * A number here is a policy the deployment has chosen — many jurisdictions
     * ask for periodic re-verification — and the gate honours it to the minute
     * rather than waiting for the sweep that writes EXPIRED.
     */
    KYC_VALID_FOR_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
    /**
     * How long identity documents are kept after a record reaches a terminal
     * state — verified, rejected or expired. After this the bytes are purged
     * and the row stays: kind, hash, size and date remain as the record of what
     * was seen. The default is five years, which is the common regulatory floor
     * for identity records; a deployment under a different regime sets its own.
     */
    KYC_DOCUMENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(7300).default(1826),

    /** Smallest withdrawal that will be taken. Paying a cent costs more than it moves. */
    WITHDRAWAL_MIN_AMOUNT: z.string().default('10'),
    /** Largest single withdrawal. */
    WITHDRAWAL_MAX_AMOUNT: z.string().default('50000'),
    /** Largest sum of withdrawals in any rolling 24 hours. Unset means no cap. */
    WITHDRAWAL_DAILY_LIMIT: z.string().optional(),
    /** Hours between one withdrawal request and the next. 0 means none. */
    WITHDRAWAL_COOLDOWN_HOURS: z.coerce.number().int().min(0).max(720).default(0),
    /**
     * Whether a verified identity is required before a withdrawal is even
     * considered. On by default; the only reason to turn it off is a deployment
     * that verifies people some other way.
     */
    WITHDRAWAL_REQUIRE_KYC: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /**
     * Requests below this are approved without a person. Unset means every
     * request waits for somebody holding `withdrawals.review`. Approval is not
     * payment: an auto-approved request still needs a person to pay it.
     */
    WITHDRAWAL_AUTO_APPROVE_BELOW: z.string().optional(),

    /**
     * Programmatic access — API keys a person mints for themselves, and service
     * tokens an administrator mints for an integration. See docs/api-keys.md.
     */
    /** The longest a key or token may live. A person may choose shorter. */
    API_KEY_MAX_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    /** What a person gets if they do not choose a lifetime. */
    API_KEY_DEFAULT_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    /** Live (unexpired, unrevoked) keys one person may hold at once. */
    API_KEY_MAX_PER_USER: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * Requests per minute one credential may make, on top of the per-address
     * limit. A key is a long-lived secret in a script; a script in a loop
     * must not take the platform down with a credential that is valid.
     */
    API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100000).default(300),

    // The order path's own ceilings, per account and per tenant, on top of the
    // per-address limit. See trading/trading-throttle.service.ts.
    ORDER_RATE_LIMIT_PER_ACCOUNT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(120),
    ORDER_RATE_LIMIT_PER_TENANT_PER_MINUTE: z.coerce
      .number()
      .int()
      .min(1)
      .max(10000000)
      .default(6000),

    REDIS_URL: z.string().startsWith('redis://'),

    // Long enough that a brute-force is hopeless; refuse to boot on a short one.
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),

    /**
     * Keys for secrets that must be readable again, newest first:
     * `<id>:<base64 32 bytes>,<id>:<base64 32 bytes>`.
     *
     * The first key writes; the rest exist so values sealed under a retired key
     * still open. Validated with the same parser the application uses, so there
     * is only ever one definition of a usable key list. `pnpm keygen` prints one.
     */
    SECRET_ENCRYPTION_KEYS: z.string().refine(
      (raw) => {
        try {
          parseEncryptionKeys(raw);
          return true;
        } catch {
          return false;
        }
      },
      {
        // No value, and no detail that would narrow a guess at the key. The
        // operator has the format in .env.example and in this comment.
        message: 'must be <id>:<base64 32-byte key>, newest first, comma-separated',
      },
    ),

    /** The name an authenticator app shows beside the six digits. */
    TOTP_ISSUER: z.string().min(1).default('Trading Platform'),
    /** How long a user has to produce a code after their password was accepted. */
    TWO_FACTOR_CHALLENGE_TTL: z.string().default('5m'),

    MARKET_DATA_PROVIDER: z.enum(['internal-simulator', 'external']).default('internal-simulator'),
    MARKET_SIMULATOR_TICK_MS: z.coerce.number().int().min(10).default(250),
    MARKET_SIMULATOR_SEED: z.coerce.number().int().default(20260821),

    /**
     * Reference levels for the simulated market: `XAUUSD:3350,BTCUSD:95000`.
     *
     * The prices shipped in code are plausible, not live, and they were plausible
     * on the day they were written. A demonstration market quoting gold two
     * hundred dollars from anywhere real is a demonstration of nothing, and
     * nobody should need a rebuild to correct it — so the anchor each instrument
     * is pulled towards can be set here.
     *
     * Anything not named keeps the built-in level. Anything named that is not an
     * instrument is ignored.
     */
    MARKET_SIMULATOR_PRICES: z
      .string()
      .default('')
      .refine(
        (raw) =>
          raw
            .split(',')
            .filter((part) => part.trim().length > 0)
            .every((part) => /^[A-Za-z0-9_]+:\d+(\.\d+)?$/.test(part.trim())),
        { message: 'must be SYMBOL:price pairs, comma-separated, e.g. XAUUSD:3350,BTCUSD:95000' },
      ),

    APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    // 'log' prints verification and reset links to the server log. It is a
    // development stand-in and refuses to run under NODE_ENV=production.
    EMAIL_PROVIDER: z.enum(['log', 'none']).default('log'),
    EMAIL_FROM: z.string().default('no-reply@trading-platform.local'),
    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).default(24),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).default(60),
    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(10),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

    /**
     * Who may open an account.
     *
     *   open    — anyone with the URL. The right setting for a local machine and
     *             for a deliberately public demo.
     *   invite  — a valid, unexpired, unspent invite code is required. Codes are
     *             minted by an administrator and stored hashed; see
     *             `auth/invites.service.ts`.
     *   closed  — nobody. Existing users sign in as usual.
     *
     * Defaulting to `open` matches how a developer expects a fresh checkout to
     * behave. That default is *refused* under NODE_ENV=production by the
     * refinement below, because a public hostname that accepts any registration
     * is not a configuration choice anyone makes on purpose — it is one nobody
     * made at all.
     */
    REGISTRATION_MODE: z.enum(['open', 'invite', 'closed']).default('open'),
    /**
     * The escape hatch for a deployment that really is meant to be open to the
     * public. It has to be set explicitly, so that "open in production" is a
     * sentence someone wrote rather than a default nobody read.
     */
    REGISTRATION_ALLOW_OPEN_IN_PRODUCTION: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** How long a minted invite code stays usable, unless one is minted with its own. */
    INVITE_CODE_TTL_HOURS: z.coerce.number().int().min(1).default(168),

    /**
     * The tenant a request falls back to when no tenant claims its hostname.
     *
     * With one tenant that is every request, and the fallback is what makes a
     * single-tenant deployment work with no configuration at all.
     */
    TENANT_DEFAULT_SLUG: z.string().min(1).default('default'),
    /**
     * Refuse a request whose hostname no tenant claims, rather than falling back.
     *
     * Off by default because a fresh checkout has one tenant and no hostname.
     * **Turn it on the moment a second tenant exists**: until then the fallback
     * is a convenience, and after that it is a way of serving one firm's data to
     * a request that was meant for another.
     */
    TENANT_HOST_STRICT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    DEFAULT_ACCOUNT_CURRENCY: z.string().length(3).default('USD'),
    // Virtual funds credited to a new demo account, posted as a real DEPOSIT
    // ledger entry. Set to '0' to open demo accounts unfunded.
    DEMO_ACCOUNT_INITIAL_BALANCE: z.string().default('100000'),

    // How old a quote may be before the engine refuses to trade on it.
    QUOTE_MAX_AGE_MS: z.coerce.number().int().min(100).default(5_000),

    /**
     * Market data integrity thresholds. See MarketIntegrityService and
     * @tp/market-core's TickGate for what each one refuses and why.
     *
     * The defaults are deliberately generous: this is a broken-feed detector, not
     * a liquidity opinion. A spread of 5% of the price, or a 10% move between two
     * consecutive ticks, does not happen on anything this platform lists — and
     * when it genuinely does, the gate re-anchors rather than freezing the price.
     * Zero disables a check.
     */
    MARKET_MAX_SPREAD_RATIO: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.05)
      .transform((value) => (value === 0 ? null : value)),
    MARKET_MAX_JUMP_RATIO: z.coerce
      .number()
      .min(0)
      .max(10)
      .default(0.1)
      .transform((value) => (value === 0 ? null : value)),
    MARKET_MAX_FUTURE_SKEW_MS: z.coerce.number().int().min(0).default(5_000),
    /**
     * Consecutive plausibility rejections after which the gate follows the market
     * rather than continuing to refuse it. A gate that never re-opens would leave
     * the engine marking positions against a price that stopped moving, which is
     * worse than the spike it was protecting against.
     */
    MARKET_REANCHOR_AFTER: z.coerce.number().int().min(1).max(1_000).default(5),
    // Resolutions the platform aggregates and persists.
    CANDLE_RESOLUTIONS: z.string().default('1,5,15,60,240,1D'),
    /**
     * Whether this instance may *contend* to ingest market data.
     *
     * It used to mean "this instance ingests", and exactly one container was
     * given it. Since the lease was added it means "this instance is allowed to
     * try": a second container with the flag set will contend, lose, and sit
     * ready to take over — which is what makes a rolling deploy not leave the
     * feed unattended. Set it to false only to keep an instance out entirely.
     */
    MARKET_INGEST_ENABLED: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((value) => value === true || value === 'true'),

    /**
     * Whether this instance may contend to run the trigger engine. As above:
     * setting it does not mean this instance runs the engine, it means it is
     * eligible to. Clearing it on *every* instance means stop-loss and
     * take-profit never fire anywhere — it is not a performance knob.
     */
    TRIGGER_ENGINE_ENABLED: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((value) => value === true || value === 'true'),
    /**
     * How long a leadership lease is good for once granted.
     *
     * This is the worst-case time a singleton loop is unled after its leader
     * dies without releasing — a killed container, a lost machine. Lower means
     * a faster takeover and less tolerance for a slow database; higher means
     * the opposite. Ten seconds is chosen against the trigger engine: ten
     * seconds without stop-losses is survivable, and a renewal that has to
     * complete inside three seconds is not demanding of a healthy database.
     */
    /**
     * Whether this instance may contend to evaluate price alerts. Its own loop
     * and its own lease: an alert that arrives twice is a duplicate
     * notification, while a stop-loss that fires twice closes a position the
     * trader still holds, and tying the two together would mean no alerts at
     * all during any incident that costs the trigger engine its lease.
     */
    PRICE_ALERTS_ENABLED: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((value) => value === true || value === 'true'),
    /**
     * How often alerts are evaluated. Not per tick: a level reached is worth
     * knowing within a second, and evaluating on the tick path would put a
     * database read behind the feed.
     */
    PRICE_ALERT_SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),

    /**
     * The longest a break-glass grant may live, whatever anybody asks for.
     *
     * A grant is an errand, not a mode somebody leaves switched on. An hour is
     * long enough to work through a customer's problem with them on the phone
     * and short enough that a forgotten one closes itself before the end of the
     * shift. Asking for longer is capped rather than refused: the person is
     * mid-incident and does not need an argument about a number.
     */
    /**
     * How many proxies at the right-hand end of `X-Forwarded-For` belong to
     * this deployment.
     *
     * **Unset and zero are different, deliberately.** `X-Forwarded-For` is a
     * header: anyone can send one, and trusting it blindly hands every caller a
     * free choice of source address — precisely the control an IP allow-list is
     * meant to be. So:
     *
     * - **unset** — this deployment has not said. The platform does not know
     *   whether the socket address is a client or a proxy, treats it as
     *   untrusted, and enforces no IP rule on it.
     * - **`0`** — a deliberate "there is nothing in front of me". The socket
     *   address is the client and is trusted.
     * - **`n`** — n proxies this deployment owns append to the chain; the
     *   client is the entry immediately to their left.
     *
     * There is no safe default for a value only the operator can know, so there
     * is no default: an unset variable produces a control that is plainly off
     * and says so, rather than one that looks on and admits everybody.
     *
     * This deployment runs behind two: a host nginx holding 80/443 and the
     * stack's own nginx container. So production sets **2**.
     */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(8).optional(),

    /**
     * Whether an `http://` webhook receiver may be registered. Off in every
     * real deployment — a signed event over plain HTTP is a signed event
     * anybody on the path can read. On only for a local test receiver, and
     * the worker has the same switch for the delivery side.
     */
    WEBHOOK_ALLOW_HTTP: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    BREAK_GLASS_MAX_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(8 * 60 * 60 * 1000)
      .default(60 * 60 * 1000),

    LEADER_LEASE_TTL_MS: z.coerce.number().int().min(2_000).max(300_000).default(10_000),
    /**
     * How often the holder renews. A third of the TTL, so two consecutive
     * renewals must fail before the lease lapses — one slow query does not
     * hand the engine to another container.
     */
    LEADER_RENEW_INTERVAL_MS: z.coerce.number().int().min(500).max(100_000).default(3_000),
    /**
     * How close to expiry the holder stops acting.
     *
     * A leader that has stalled cannot ask the database whether it still leads
     * — the stall is usually why. So it stands down on its own clock, this far
     * before the lease it last saw runs out, leaving the successor a margin in
     * which the old leader has already stopped.
     */
    LEADER_GUARD_MS: z.coerce.number().int().min(0).max(60_000).default(1_000),

    // Lower bound between margin-level evaluations for one account.
    STOP_OUT_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),

    // Lower bound between account valuations pushed to one connected client.
    // Throttling, not polling: nothing runs when the market is still.
    REALTIME_VALUATION_INTERVAL_MS: z.coerce.number().int().min(0).default(500),
    /**
     * How often the symbol→accounts routing index is re-derived from the database.
     *
     * The index only ever decides *whether to value an account now*, so being
     * stale costs an unnecessary valuation and never a wrong number. Lower means
     * a closed position stops being valued sooner; higher means fewer queries.
     * Thirty seconds is generous in the safe direction.
     */
    EXPOSURE_INDEX_REFRESH_MS: z.coerce.number().int().min(1000).default(30_000),

    TRADING_SERVER_TIMEZONE: z.string().default('UTC'),
    /**
     * How long an interactive transaction may run before Prisma expires it.
     *
     * Writes to one account serialise on its ledger row, so a burst of orders on
     * the same account queues. Prisma's 5s default expired transactions that were
     * only waiting their turn — a load test showed orders failing that way. This
     * is generous enough to absorb a realistic burst and still short enough that a
     * genuinely stuck transaction does not hold a connection all day.
     */
    DATABASE_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
    /** How long a request waits for a pooled connection before giving up. */
    DATABASE_TRANSACTION_MAX_WAIT_MS: z.coerce.number().int().min(500).default(10_000),
    /**
     * How often account snapshots are taken. 0 disables them.
     *
     * Snapshots run inside the API rather than the worker because equity needs the
     * live quote cache and `AccountStateService` — the single definition of what
     * an account is worth. See snapshot.service.ts.
     */
    ACCOUNT_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),
    /**
     * How often the platform asks venues what became of orders whose answers
     * were lost. 0 disables the sweep, leaving UNCONFIRMED orders for a person
     * to resolve by hand — which is a choice, not a default.
     */
    VENUE_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
    /**
     * How long an order is left alone before the venue is asked about it. The
     * original request may still be in flight; a query that overtakes it reads
     * a state about to change.
     */
    VENUE_RECOVERY_GRACE_MS: z.coerce.number().int().min(0).default(5_000),
    DEFAULT_ACCOUNT_LEVERAGE: z.coerce.number().int().min(1).default(100),
    IDEMPOTENCY_KEY_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),
    /**
     * How long an IN_PROGRESS idempotency claim may stand before a retry with
     * the same key may take it over. A claim that old with nothing committed
     * belongs to a process that died before it committed; a live request is
     * bounded by the transaction budget many times over. Five minutes is
     * generous for the one and short for the other.
     */
    IDEMPOTENCY_TAKEOVER_AFTER_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(60 * 60 * 1000)
      .default(5 * 60 * 1000),

    RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().min(1).default(5),
    RATE_LIMIT_ORDERS_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    /**
     * Inbound WebSocket messages per socket per minute.
     *
     * A terminal sends five subscribes on connect and one more when the chart
     * changes instrument. A hundred is generous for a person and cheap for an
     * attacker to exceed.
     */
    RATE_LIMIT_SOCKET_MESSAGES_PER_MINUTE: z.coerce.number().int().min(1).default(100),
  })
  /**
   * Cross-field rules. These are the ones a single field cannot express, and
   * every one of them is a configuration that boots happily and is wrong.
   */
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === 'production' &&
      env.REGISTRATION_MODE === 'open' &&
      !env.REGISTRATION_ALLOW_OPEN_IN_PRODUCTION
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REGISTRATION_MODE'],
        message:
          'REGISTRATION_MODE=open in production means any visitor can open an account. ' +
          'Set REGISTRATION_MODE=invite or closed, or, if a public sign-up is genuinely ' +
          'intended, set REGISTRATION_ALLOW_OPEN_IN_PRODUCTION=true to say so on purpose.',
      });
    }
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

/**
 * Rate limits, read at module-definition time.
 *
 * `@Throttle` is a decorator: it is evaluated when the controller class is
 * defined, which is before the DI container — and therefore `ConfigService` —
 * exists. Reading `process.env` here is the only way a per-route limit can be
 * configuration rather than a literal.
 *
 * This does not skip validation. The same variable names are in the Zod schema
 * above, so a malformed value still refuses to boot; these accessors only decide
 * what the decorators see, and fall back to the schema's own defaults.
 *
 * The alternative — literals in the decorators — was what this codebase had, and
 * it was worse than it looked: `RATE_LIMIT_LOGIN_PER_MINUTE` was declared,
 * documented in `.env.example`, and read by nothing. An operator tightening it
 * would have believed they had tightened it.
 */
function rateLimitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export const RATE_LIMIT_WINDOW_MS = 60_000;

export const rateLimits = {
  get login(): number {
    return rateLimitFromEnv('RATE_LIMIT_LOGIN_PER_MINUTE', 5);
  },
  get orders(): number {
    return rateLimitFromEnv('RATE_LIMIT_ORDERS_PER_MINUTE', 120);
  },
  get api(): number {
    return rateLimitFromEnv('RATE_LIMIT_API_PER_MINUTE', 600);
  },
  /**
   * Inbound WebSocket messages per socket per minute.
   *
   * A terminal sends a handful: five subscribes on connect, one more when the
   * chart changes instrument. A hundred is generous for a person and cheap for
   * an attacker to exceed, which is what makes it a useful line.
   */
  get socketMessages(): number {
    return rateLimitFromEnv('RATE_LIMIT_SOCKET_MESSAGES_PER_MINUTE', 100);
  },
};

/**
 * The CORS allowlist, read the same way the rate limits are and for the same
 * reason: `@WebSocketGateway` is a decorator, evaluated before the DI container
 * exists, so `ConfigService` is not available to it.
 *
 * `origin: true` was what the gateway had — which reflects whatever `Origin` the
 * request carried, and therefore allows every site on the internet to open an
 * authenticated socket against this API from a logged-in user's browser. The
 * HTTP side has been on an allowlist since it was written; the socket was not.
 */
export function socketCorsOrigins(): string[] | boolean {
  const configured = corsOrigins(process.env['CORS_ORIGINS'] ?? '');
  if (configured.length > 0) return configured;

  /**
   * No allowlist configured. In production that is a refusal, not a wildcard:
   * a deployment that forgot to set it should fail closed and be noticed on the
   * first connection, rather than quietly accepting everybody.
   */
  return process.env['NODE_ENV'] === 'production' ? false : true;
}
