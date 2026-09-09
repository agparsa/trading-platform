import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { DomainError, TradingErrorCode, UserRole } from '@tp/shared-types';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import type { RequestWithContext } from '../common/request-context';
import { resolveClientIp } from './client-ip';
import { IpRulesService } from './ip-rules.service';
import type { Env } from '../config/env.schema';

/**
 * Where a firm's people may reach it from (§46).
 *
 * Runs **after** authentication, because the rule set is per tenant and the
 * scope depends on whether the caller is staff. An unauthenticated request has
 * no tenant rules to apply to it — the sign-in page must stay reachable, or a
 * misconfigured allow-list would leave nobody able to get in and fix it.
 *
 * ## It never enforces on an address it does not trust
 *
 * `TRUSTED_PROXY_HOPS` says how many proxies this deployment owns. While it is
 * unset the platform cannot tell a client's address from an nginx container's,
 * and while it is set too high the forwarded chain will not have the promised
 * shape. In either case nothing is enforced, and the fact is logged once per
 * process rather than silently.
 *
 * That is fail-open, deliberately. The alternative — refuse everybody when the
 * platform cannot tell who they are — locks out the person who would fix the
 * misconfiguration, permanently, with no route back. `IpRulesService` refuses
 * to *create* a rule in that state, so reaching it takes a configuration change
 * after the fact, which is loud.
 */
@Injectable()
export class IpRulesGuard implements CanActivate {
  private readonly logger = new Logger(IpRulesGuard.name);
  private warned = false;

  constructor(
    private readonly reflector: Reflector,
    private readonly rules: IpRulesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const user = request.user;
    if (user === undefined) return true;

    const hops = this.config.get('TRUSTED_PROXY_HOPS', { infer: true });
    const resolved = resolveClientIp(request.ip, request.header('x-forwarded-for'), hops);

    /**
     * The rules are read before the trust check, so a firm that has rules and a
     * deployment that cannot enforce them produces a warning rather than
     * silence. A control that is off and looks on is worse than one that is
     * plainly off.
     */
    const active = await this.rules.active();
    if (active.length === 0) return true;

    if (!resolved.trusted) {
      if (!this.warned) {
        this.warned = true;
        this.logger.error(
          { hops },
          'IP rules exist but are NOT being enforced: the client address cannot be determined. Set TRUSTED_PROXY_HOPS to the number of proxies in front of this API (0 if none).',
        );
      }
      return true;
    }

    const scope = user.role === UserRole.USER ? 'EVERYONE' : 'STAFF';
    const decision = await this.rules.decide(resolved.address, scope);
    if (decision.allowed) return true;

    /**
     * The refusal says the address and nothing about the rules.
     *
     * A caller who is being kept out does not get to learn the shape of the
     * allow-list by probing it, and a person who is legitimately locked out
     * needs exactly one fact to tell their administrator: the address they are
     * coming from.
     */
    this.logger.warn(
      { userId: user.id, address: resolved.address, reason: decision.reason },
      'Refused by an IP rule',
    );
    throw new DomainError(
      TradingErrorCode.FORBIDDEN,
      `This firm does not accept connections from ${resolved.address}`,
      { address: resolved.address },
    );
  }
}
