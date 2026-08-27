import { Injectable } from '@nestjs/common';
import type { Account, Prisma } from '@prisma/client';
import { DomainError, Permission, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/** How a caller reached an account. Recorded so an action can be explained later. */
export const AccountAccessRoute = {
  /** The caller owns it. */
  OWNER: 'OWNER',
} as const;
export type AccountAccessRoute = (typeof AccountAccessRoute)[keyof typeof AccountAccessRoute];

/**
 * The answer to "may this caller act on this account, and how".
 *
 * A boolean would not survive master accounts: two callers can both reach an
 * account and be allowed different things on it, and the difference has to
 * travel with the answer rather than be re-derived by whoever asked.
 */
export interface AccountGrant {
  /**
   * The account row, handed back rather than re-fetched.
   *
   * The resolver has to read the account to answer at all, so returning it
   * costs nothing and removes the one temptation that would undo this whole
   * arrangement: a caller that queries the account itself "just for the
   * leverage" is a caller that could equally have skipped the resolver.
   */
  readonly account: Account;
  readonly via: AccountAccessRoute;
  readonly capabilities: ReadonlySet<Permission>;
}

/**
 * What owning an account lets you do to it.
 *
 * This is not the same list as the `USER` role's permissions and must not be
 * collapsed into it. The role answers "may this kind of user ever place an
 * order"; this answers "may this person place one *on this account*". Both are
 * checked, in different places, and neither substitutes for the other — which
 * is the point of keeping two lists that presently look alike.
 */
const OWNER_CAPABILITIES: readonly Permission[] = [
  Permission.ACCOUNTS_READ,
  Permission.ORDERS_READ,
  Permission.ORDERS_CREATE,
  Permission.ORDERS_CANCEL,
  Permission.ORDERS_MODIFY,
  Permission.POSITIONS_READ,
  Permission.POSITIONS_CLOSE,
  Permission.POSITIONS_MODIFY,
];

/**
 * One place that decides whether a caller may touch an account.
 *
 * Before this existed the decision was made in eight places across three
 * services, in two different idioms, and one route — `GET /accounts/:id/state`
 * — got it only as a side effect of an unrelated call whose result was thrown
 * away. Every one of those was correct on the day it was written, and none of
 * them had a way of staying correct: an account is reachable by exactly as many
 * paths as somebody remembers to guard.
 *
 * Two properties are worth stating, because everything built on top depends on
 * them.
 *
 * **Knowing an account id is never enough.** The resolver takes the caller and
 * the account and answers from stored relationships. There is no argument a
 * client can send that widens what comes back.
 *
 * **A refusal reads as "not found".** Telling an unauthorised caller that an
 * account exists turns id enumeration into an account census. They learn the
 * same thing either way — they may not have it.
 *
 * This is a service and not a Nest guard on purpose. Write paths resolve the
 * account inside the transaction that locks its row; a guard decides before the
 * transaction opens, leaving a gap between the decision and the act.
 * Authorisation checked outside the lock it protects is not checked.
 */
@Injectable()
export class AccountAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the caller's access to one account, or throws.
   *
   * `needs` names the capability the operation about to run requires. Today
   * every owner holds all of them, so for an owner this parameter cannot
   * refuse anything — it is passed anyway because the master-account link is
   * what will discriminate on it, and naming the capability at each call site
   * now is cheaper and far safer than retrofitting fifteen call sites at the
   * moment the first narrower grant appears.
   */
  async resolve(
    userId: string,
    accountId: string,
    needs: Permission,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<AccountGrant> {
    const account = await client.account.findUnique({ where: { id: accountId } });

    if (account === null || account.userId !== userId) throw this.notFound(accountId);

    const capabilities = new Set(OWNER_CAPABILITIES);
    if (!capabilities.has(needs)) {
      /**
       * The owner of an account already knows it exists, so hiding it from them
       * would be theatre. Naming the capability is the same courtesy the
       * route-level guard extends.
       */
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `This operation needs ${needs} on this account, which you do not hold`,
        { accountId, missing: needs },
      );
    }

    return { account, via: AccountAccessRoute.OWNER, capabilities };
  }

  /**
   * The one refusal for "you may not reach this account".
   *
   * A single method rather than eight call sites, so no future route can
   * accidentally distinguish "no such account" from "not yours" by wording its
   * own error slightly differently. That distinction is the whole leak.
   */
  private notFound(accountId: string): DomainError {
    return new DomainError(TradingErrorCode.RESOURCE_NOT_FOUND, 'Account not found', { accountId });
  }
}
