import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainError, TradingErrorCode } from '@tp/shared-types';
import { requireTenantId } from '@tp/tenancy';
import type { Env } from '../config/env.schema';
import { RedisService } from '../redis/redis.service';

/**
 * Two ceilings on the order path, on top of the per-address one every route
 * has and the per-credential one a key has.
 *
 * **Per account**: a runaway bot, a script in a retry loop, or a person with a
 * stuck key must not be able to turn one account into a firehose. The limit
 * is per account rather than per person because a master account acting for
 * a hundred followers is a hundred accounts' worth of orders, legitimately.
 *
 * **Per tenant**: what one firm may put through the engine in a minute, so a
 * broker's incident is that broker's incident. Set from the deployment's
 * capacity, not from a guess about a firm's business.
 *
 * Fixed windows in Redis, one increment each. If Redis cannot answer, the
 * order is allowed and the failure logged: the address limit still stands,
 * and refusing every trade for a cache blip is the worse failure — the same
 * reasoning as the credential throttle, and the same shape of code.
 *
 * Reads are not counted. A watchlist refreshing is not a trading decision.
 */
@Injectable()
export class TradingThrottle {
  private readonly logger = new Logger(TradingThrottle.name);
  private readonly perAccount: number;
  private readonly perTenant: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.perAccount = config.get('ORDER_RATE_LIMIT_PER_ACCOUNT_PER_MINUTE', { infer: true });
    this.perTenant = config.get('ORDER_RATE_LIMIT_PER_TENANT_PER_MINUTE', { infer: true });
  }

  /** Counts one trading action against the account and its tenant, refusing over either ceiling. */
  async assertAllowed(accountId: string, now: Date = new Date()): Promise<void> {
    const tenantId = requireTenantId();
    const minute = Math.floor(now.getTime() / 60_000);
    let account: number;
    let tenant: number;
    try {
      [account, tenant] = await Promise.all([
        this.bump(`trading:rl:account:${accountId}:${minute}`),
        this.bump(`trading:rl:tenant:${tenantId}:${minute}`),
      ]);
    } catch (error) {
      this.logger.warn({ err: error, accountId }, 'Order-path rate limit unavailable; allowing');
      return;
    }
    if (account > this.perAccount) {
      throw new DomainError(
        TradingErrorCode.RATE_LIMITED,
        `This account may place ${this.perAccount} trading actions a minute`,
        { limit: String(this.perAccount), scope: 'account' },
      );
    }
    if (tenant > this.perTenant) {
      this.logger.warn({ tenantId, minute }, 'Tenant order-path ceiling reached');
      throw new DomainError(
        TradingErrorCode.RATE_LIMITED,
        'The platform is receiving more orders than it will accept this minute. Retry shortly.',
        { limit: String(this.perTenant), scope: 'tenant' },
      );
    }
  }

  private async bump(key: string): Promise<number> {
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, 120);
    return count;
  }
}
