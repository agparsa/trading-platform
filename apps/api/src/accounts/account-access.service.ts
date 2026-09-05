import { Injectable } from '@nestjs/common';
import type { Account, Prisma } from '@prisma/client';
import { DomainError, isLinkableCapability, Permission, TradingErrorCode } from '@tp/shared-types';
import { PrismaService } from '../prisma/prisma.service';

/** How a caller reached an account. Recorded so an action can be explained later. */
export const AccountAccessRoute = {
  /** The caller owns it. */
  OWNER: 'OWNER',
  /** The caller operates a master account holding an active link to it. */
  MASTER_LINK: 'MASTER_LINK',
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
  /**
   * The link that granted this, when the caller is not the owner.
   *
   * Carried so an action taken on someone else's account can be explained
   * afterwards by pointing at the specific delegation that allowed it, rather
   * than by re-deriving who could have done it at the time.
   */
  readonly linkId: string | null;
  /**
   * The desk the caller came through, when they came through one.
   *
   * Carried because the risk hierarchy has a desk layer: a ceiling a broker
   * puts on a desk binds orders that desk's operators place, and does not bind
   * the account's own owner, who never agreed to it. Knowing *which* desk an
   * order arrived through is the only way to apply that correctly, and the
   * resolver is the one place that already knows.
   */
  readonly masterAccountId: string | null;
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
    if (account === null) throw this.notFound(accountId);

    if (account.userId === userId) {
      return this.grant(account, AccountAccessRoute.OWNER, null, OWNER_CAPABILITIES, needs, null);
    }

    /**
     * The delegated path. Note what is *not* in this query: the account id is
     * not enough on its own, and neither is operating a master account. Both
     * must already be joined by a stored, active link, granted by somebody, at
     * a recorded time. A master with a hundred links reaches exactly a hundred
     * accounts.
     *
     * The master account's own status is part of the predicate rather than
     * checked afterwards, so suspending a master stops every one of its links
     * at once without touching them.
     */
    const link = await client.masterAccountLink.findFirst({
      where: {
        accountId,
        status: 'ACTIVE',
        master: { userId, status: 'ACTIVE' },
      },
      select: { id: true, capabilities: true, masterAccountId: true },
    });
    if (link === null) throw this.notFound(accountId);

    /**
     * Filtered against the ceiling on the way out, not only on the way in.
     * Validating at grant time protects against a bad request; filtering here
     * protects against a row that got into the table some other way — a manual
     * fix, a restored backup, a migration written before the ceiling existed.
     */
    return this.grant(
      account,
      AccountAccessRoute.MASTER_LINK,
      link.id,
      link.capabilities.filter(isLinkableCapability),
      needs,
      link.masterAccountId,
    );
  }

  private grant(
    account: Account,
    via: AccountAccessRoute,
    linkId: string | null,
    granted: readonly Permission[],
    needs: Permission,
    masterAccountId: string | null,
  ): AccountGrant {
    const capabilities: ReadonlySet<Permission> = new Set(granted);
    if (!capabilities.has(needs)) {
      /**
       * A caller who got this far can already see that the account exists —
       * they own it, or they hold a link to it. Hiding it now would be theatre,
       * so the refusal names the capability, as the route-level guard does.
       */
      throw new DomainError(
        TradingErrorCode.FORBIDDEN,
        `This operation needs ${needs} on this account, which you do not hold`,
        { accountId: account.id, missing: needs },
      );
    }
    return { account, via, linkId, masterAccountId, capabilities };
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
